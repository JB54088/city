/* Run against an isolated demo instance; defaults to port 8003, never the shared 8002 data. */
const assert = require('node:assert/strict');
const { chromium, request } = require('playwright');

const baseUrl = (process.env.CITYTRACE_URL || 'http://127.0.0.1:8003').replace(/\/$/, '');
assert.notEqual(new URL(baseUrl).port, '8002', 'Use an isolated demo instance, not the shared port 8002.');
const widths = [320, 360, 390, 430, 768, 1024, 1440];
const errors = [];
let navigation = 0;

async function api(client, method, path, data) {
  const response = await client.fetch(`${baseUrl}/api${path}`, { method, ...(data === undefined ? {} : { data }) });
  const payload = await response.json();
  assert.ok(response.ok() && payload.ok, `${method} ${path}: ${response.status()} ${JSON.stringify(payload)}`);
  return payload.data;
}

async function openPage(page, hash, ready) {
  // A fresh document makes each width/page measurement independent of earlier UI state.
  const response = await page.goto(`${baseUrl}/?mobile-regression=${++navigation}#/${hash}`, { waitUntil: 'networkidle' });
  assert.equal(response.status(), 200);
  await page.locator(ready).first().waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
}

async function settleFrame(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function noOverflow(page, label) {
  await settleFrame(page);
  const layout = await page.evaluate(() => {
    const width = window.innerWidth;
    const offenders = [...document.querySelectorAll('body *')].filter(element => {
      const box = element.getBoundingClientRect();
      return box.width && box.height && (box.right > width + 1 || box.left < -1);
    }).slice(0, 8).map(element => ({
      tag: element.tagName, id: element.id, class: element.getAttribute('class'),
      left: Math.round(element.getBoundingClientRect().left), right: Math.round(element.getBoundingClientRect().right)
    }));
    return { width, scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth), offenders };
  });
  assert.ok(layout.scrollWidth <= layout.width + 1, `${label}: horizontal overflow ${JSON.stringify(layout)}`);
}

function waitApi(page, path, method = 'GET', predicate = () => true) {
  return page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === `/api${path}` && response.request().method() === method && predicate(url);
  });
}

async function modalKeyboard(page) {
  const opener = page.locator('#top-login');
  await opener.click();
  const dialog = page.locator('#modal-root [role="dialog"]');
  await dialog.waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#modal-root [role="dialog"]')?.contains(document.activeElement));
  const controls = dialog.locator('button:not([disabled]):visible,input:not([disabled]):visible,select:not([disabled]):visible,textarea:not([disabled]):visible,a[href]:visible');
  assert.ok(await controls.count() > 2, 'login dialog must have reachable controls');
  await controls.first().focus();
  await page.keyboard.press('Shift+Tab');
  assert.ok(await controls.last().evaluate(element => document.activeElement === element), 'Shift+Tab must stay inside login dialog');
  await page.keyboard.press('Tab');
  assert.ok(await controls.first().evaluate(element => document.activeElement === element), 'Tab must wrap inside login dialog');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.ok(await opener.evaluate(element => document.activeElement === element), 'closing login must restore the opener focus');
}

async function searchAndNavigation(page) {
  await openPage(page, 'discover', '#search-q');
  const search = page.locator('#search-q');
  const first = waitApi(page, '/routes', 'GET', url => url.searchParams.get('q') === '福');
  await search.fill('福');
  await first;
  await page.locator('#discover-results[aria-busy="false"]').waitFor();
  assert.ok(await search.evaluate(element => document.activeElement === element), 'debounced search must keep the input focused');
  const second = waitApi(page, '/routes', 'GET', url => url.searchParams.get('q') === '福州');
  await search.pressSequentially('州', { delay: 420 });
  await second;
  await page.locator('#discover-results[aria-busy="false"]').waitFor();
  assert.equal(await search.inputValue(), '福州');
  assert.ok(await search.evaluate(element => document.activeElement === element), 'typing after a debounce must continue in the same input');
  const reset = waitApi(page, '/routes', 'GET', url => !url.searchParams.has('q'));
  await page.locator('#clear-filters').click();
  await reset;
  assert.equal(await search.inputValue(), '');
  await page.locator('.route-card').first().waitFor();

  let started, release, completed;
  const requestStarted = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const done = new Promise(resolve => { completed = resolve; });
  const delayed = async route => {
    if (new URL(route.request().url()).searchParams.get('q') !== '慢响应回归') return route.continue();
    try {
      const response = await route.fetch();
      started();
      await gate;
      await route.fulfill({ response });
    } finally { completed(); }
  };
  await page.route('**/api/routes?*', delayed);
  try {
    await search.fill('慢响应回归');
    await requestStarted;
    await page.locator('.bottom-nav [data-nav="map"]').click();
    await page.locator('#app[data-page="map"] .detail-map').waitFor();
    const late = waitApi(page, '/routes', 'GET', url => url.searchParams.get('q') === '慢响应回归');
    release();
    await (await late).finished();
    await done;
    await settleFrame(page);
    assert.equal(new URL(page.url()).hash, '#/map');
    assert.equal(await page.locator('#app').getAttribute('data-page'), 'map', 'a late search response must not replace the next page');
    await page.locator('.bottom-nav [data-nav="discover"]').click();
    await page.locator('#search-q').waitFor();
    await page.locator('#clear-filters').click();
    await page.locator('.route-card').first().waitFor();
  } finally {
    release();
    await page.unroute('**/api/routes?*', delayed);
  }
}

async function profileTabs(page, publicRoute, draft, follow) {
  await openPage(page, 'profile', '#logout-button');
  await page.getByRole('button', { name: /收藏路线/ }).click();
  await page.locator('[data-trip-tab="favorites"].active').waitFor();
  await page.locator(`#app a[href="#/route/${publicRoute.id}"]`).first().waitFor();
  await openPage(page, 'profile', '#logout-button');
  await page.getByRole('button', { name: /复刻历史/ }).click();
  await page.locator('[data-trip-tab="follows"].active').waitFor();
  await page.locator(`#app a[href="#/follow/${follow.id}"]`).waitFor();
  await page.locator('[data-trip-tab="routes"]').click();
  await page.locator('[data-trip-tab="routes"].active').waitFor();
  await page.locator(`#app a[href="#/route/${draft.id}"]`).waitFor();
}

async function editorAndFollow(page, fixtureApi, draft, follow) {
  await openPage(page, `edit/${draft.id}`, '#edit-title');
  const unsaved = '刷新路段后仍保留的打卡输入';
  await page.locator('#cp-name').fill(unsaved);
  await page.locator('#cp-note').fill('手机编辑时尚未提交的现场备注');
  await page.locator('[data-leg-mode]').first().selectOption('cycling');
  const legSaved = waitApi(page, `/legs/${draft.legId}`, 'PATCH');
  await page.locator('[data-save-leg]').first().click();
  await legSaved;
  await page.waitForFunction(() => document.querySelector('[data-leg-mode]')?.value === 'cycling' && !document.querySelector('[data-save-leg]')?.disabled);
  assert.equal(await page.locator('#cp-name').inputValue(), unsaved, 'saving a leg must preserve unsaved waypoint input');
  const title = `${draft.title} · 已保存`;
  await page.locator('#edit-title').fill(title);
  const metadata = waitApi(page, `/routes/${draft.id}`, 'PATCH');
  await page.locator('#save-route').click();
  await metadata;
  assert.equal((await api(fixtureApi, 'GET', `/routes/${draft.id}`)).title, title);

  await page.locator('#cp-name').fill(unsaved);
  await page.locator('#cp-lat').fill('26.082');
  await page.locator('#cp-lon').fill('119.294');
  const checkpoint = waitApi(page, `/routes/${draft.id}/checkpoints`, 'POST');
  await page.locator('#add-checkpoint').click();
  await checkpoint;
  await page.waitForFunction(() => document.querySelectorAll('[data-edit-cp]').length === 3);
  assert.equal((await api(fixtureApi, 'GET', `/routes/${draft.id}`)).waypoints.length, 3);

  await openPage(page, `follow/${follow.id}`, '.follow-map');
  const arrived = waitApi(page, `/follow-sessions/${follow.id}/checkpoints`, 'POST');
  await page.locator('[data-checkin]').first().click();
  await arrived;
  assert.equal((await api(fixtureApi, 'GET', `/follow-sessions/${follow.id}`)).completed_count, 1);
  await page.locator('#follow-pause').click();
  await page.locator('#follow-resume').waitFor();
  assert.equal(await page.locator('[data-checkin]:enabled').count(), 0, 'paused follow sessions must not offer arrival confirmation');
  await page.locator('#follow-resume').click();
  await page.locator('#follow-pause').waitFor();
  const finished = waitApi(page, `/follow-sessions/${follow.id}/finish`, 'PATCH');
  await page.locator('#follow-finish').click();
  await finished;
  await page.locator('#follow-finish').waitFor({ state: 'detached' });
  assert.equal((await api(fixtureApi, 'GET', `/follow-sessions/${follow.id}`)).status, 'completed');
}

async function layoutMatrix(page, publicRoute, draft, follow) {
  const pages = [
    ['discover', '#search-q'], ['map', '.detail-map'], ['record', '.record-panel'],
    ['trips', '.trips-tabs'], ['profile', '#logout-button'],
    [`route/${publicRoute.id}`, '.route-detail-head'], [`edit/${draft.id}`, '#edit-title'],
    [`follow/${follow.id}`, '.follow-map']
  ];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    for (const [hash, ready] of pages) {
      await openPage(page, hash, ready);
      await noOverflow(page, `${width}px ${hash.split('/')[0]}`);
      if (hash === 'discover' && width <= 430) {
        const firstCard = await page.locator('.route-card').first().boundingBox();
        const navigation = await page.locator('.bottom-nav').boundingBox();
        assert.ok(firstCard.y < navigation.y - 100, `${width}px discovery must show route content in the first screen`);
      }
      if (hash.startsWith('route/')) {
        const bar = page.locator('.v2-route-actions');
        if (await bar.isVisible()) {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          await settleFrame(page);
          const actions = await bar.boundingBox();
          const nav = await page.locator('.bottom-nav').boundingBox();
          const content = await page.locator('.detail-layout').boundingBox();
          assert.ok(actions.y + actions.height <= nav.y + 1, `${width}px route actions must sit above navigation`);
          assert.ok(content.y + content.height <= actions.y - 4, `${width}px last route content must be reachable above the action bar`);
          for (const button of await bar.locator('button').all()) {
            const box = await button.boundingBox();
            assert.ok(box.height >= 44 && box.width >= 44, `${width}px route action needs a usable touch target`);
          }
        }
      }
    }
    console.log(`Layout passed: ${width}px, ${pages.length} pages.`);
  }
}

async function publishRouteThroughUi(page, fixtureApi, draft) {
  const detail = await api(fixtureApi, 'GET', `/routes/${draft.id}`);
  const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000b49444154789c636000020000050001a5f645400000000049454e44ae426082', 'hex').toString('base64');
  for (const waypoint of detail.waypoints) {
    await api(fixtureApi, 'POST', `/waypoints/${waypoint.id}/photos`, { data_url: png, kind: 'checkpoint' });
  }
  const legs = await api(fixtureApi, 'GET', `/routes/${draft.id}/legs`);
  for (const [index, leg] of legs.entries()) {
    await api(fixtureApi, 'PATCH', `/legs/${leg.id}`, { transport_mode: index ? 'subway' : 'walking' });
  }
  await openPage(page, `edit/${draft.id}`, '#submit-route');
  await page.locator('#privacy-confirm').check();
  const submitted = waitApi(page, `/routes/${draft.id}/submit`, 'POST');
  await page.locator('#submit-route').click();
  const response = await submitted;
  assert.equal(response.request().postDataJSON().privacy_confirmed, true, 'the UI must send the checked privacy consent');
  assert.equal(response.status(), 200, 'a complete route must reach review through the UI');
  await page.locator('.status-pill.pending_review').waitFor();
  assert.equal((await api(fixtureApi, 'GET', `/routes/${draft.id}`)).status, 'pending_review');
  const adminApi = await request.newContext();
  const visitorApi = await request.newContext();
  try {
    await api(adminApi, 'POST', '/auth/login', { email: 'admin@citytrace.demo', password: 'admin123' });
    await api(adminApi, 'POST', `/admin/routes/${draft.id}/approve`, { note: 'Independent browser regression with synthetic GPS and image fixtures' });
    const published = await api(visitorApi, 'GET', `/routes/${draft.id}`);
    assert.equal(published.status, 'published');
    assert.ok(published.geometry.length, 'published route must have privacy-trimmed geometry');
    assert.equal(published.waypoints.length, 3);
    assert.ok(published.waypoints.every(point => point.photos.length));
    assert.equal('private_track' in published, false, 'visitor must not receive private source GPS');
  } finally { await adminApi.dispose(); await visitorApi.dispose(); }
  console.log('Publishing passed: UI consent, submission, administrator approval and public access without private GPS.');
}

async function failedLogout(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPage(page, 'profile', '#logout-button');
  const denyLogout = route => route.abort('internetdisconnected');
  await page.route('**/api/auth/logout', denyLogout);
  try {
    await page.locator('#logout-button').click();
    await page.locator('#toast-stack .error').waitFor();
    assert.ok(await page.locator('#top-profile').isVisible(), 'failed logout must not pretend the account is signed out');
    assert.ok(await page.locator('#logout-button').isVisible());
  } finally { await page.unroute('**/api/auth/logout', denyLogout); }
  await page.locator('#logout-button').click();
  await page.locator('#top-login').waitFor({ state: 'visible' });
  assert.equal((await page.request.get(`${baseUrl}/api/auth/me`)).status(), 401);
}

(async () => {
  const fixtureApi = await request.newContext();
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  page.on('pageerror', error => errors.push(error.message));
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const email = `mobile-${suffix}@example.com`, password = `Mobile-${suffix}`;
  try {
    const health = await fixtureApi.get(`${baseUrl}/health`);
    assert.equal(health.status(), 200, 'isolated demo server must be running');
    const publicRoute = (await api(fixtureApi, 'GET', '/routes')).items[0];
    assert.ok(publicRoute, 'demo server must provide a published route');
    await api(fixtureApi, 'POST', '/auth/register', { nickname: '手机回归测试漫游者', email, password });
    const track = await api(fixtureApi, 'POST', '/tracks', {});
    const sampleTime = Date.now() - 50000;
    await api(fixtureApi, 'POST', `/tracks/${track.id}/points`, { samples: Array.from({ length: 6 }, (_, index) => ({
      client_id: `mobile-${suffix}-${index}`, lat: 26.08, lon: 119.29 + index * 0.0008, accuracy: 8, ts: sampleTime + index * 10000
    })) });
    await api(fixtureApi, 'POST', `/tracks/${track.id}/finish`, {});
    const title = `手机编辑回归 · 一段穿过城市街巷的路线 ${suffix.slice(-6)}`;
    const draft = await api(fixtureApi, 'POST', '/routes', { track_id: track.id, title });
    draft.title = title;
    await api(fixtureApi, 'PATCH', `/routes/${draft.id}`, { city: '福州', category: '街巷', description: '这是独立验证实例中的测试路线。记录沿途街巷、站点和实际交通方式。'.repeat(3) });
    for (const [index, name] of ['街口出发点', '沿途的一家城市小店'].entries()) {
      await api(fixtureApi, 'POST', `/routes/${draft.id}/waypoints`, { name, kind: '景点', position: index, lat: 26.08, lon: 119.29 + index * 0.0016, location_source: 'track' });
    }
    draft.legId = (await api(fixtureApi, 'GET', `/routes/${draft.id}/legs`))[0].id;
    await api(fixtureApi, 'POST', `/routes/${publicRoute.id}/favorite`, {});
    const follow = await api(fixtureApi, 'POST', `/routes/${publicRoute.id}/follow`, {});

    await openPage(page, 'discover', '#search-q');
    await modalKeyboard(page);
    await searchAndNavigation(page);
    await page.locator('#top-login').click();
    await page.locator('#auth-form input[name="email"]').fill(email);
    await page.locator('#auth-form input[name="password"]').fill(password);
    await page.locator('#auth-form button[type="submit"]').click();
    await page.locator('#top-profile').waitFor({ state: 'visible' });
    await page.locator('#auth-form').waitFor({ state: 'detached' });
    await profileTabs(page, publicRoute, draft, follow);
    await editorAndFollow(page, fixtureApi, draft, follow);
    await layoutMatrix(page, publicRoute, draft, follow);
    await publishRouteThroughUi(page, fixtureApi, draft);
    await failedLogout(page);
    assert.deepEqual(errors, [], `browser runtime errors: ${errors.join('; ')}`);
    console.log(`Mobile experience passed: ${widths.join('/')}px; search, stale responses, modal keyboard, account tabs, editor, follow, publishing, and logout; no runtime exceptions.`);
  } catch (error) {
    await page.screenshot({ path: '/tmp/citytrace-mobile-experience-failure.png', fullPage: true }).catch(() => {});
    if (errors.length) console.error('Browser errors:', errors);
    throw error;
  } finally {
    await context.close();
    await browser.close();
    await fixtureApi.dispose();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
