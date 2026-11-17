/* Synthetic GPS and offline regressions; run only against an isolated demo instance. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const BASE = (process.env.CITYTRACE_URL || 'http://127.0.0.1:8003').replace(/\/$/, '');
async function jsonApi(client, method, path, body) {
  const response = await client.fetch(BASE + '/api' + path, { method, ...(body === undefined ? {} : { data: body }) });
  const payload = await response.json();
  assert.ok(response.ok() && payload.ok, `${method} ${path}: ${JSON.stringify(payload)}`);
  return payload.data;
}

async function recordingLifecycle(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    let watcher = null;
    window.testGpsDenied = true;
    window.testGpsStopped = false;
    const position = lon => ({ coords: { latitude: 26.08, longitude: lon, accuracy: 7, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
    navigator.geolocation.getCurrentPosition = (success, error) => {
      queueMicrotask(() => window.testGpsDenied ? error({ code: 1, message: 'Permission denied' }) : success(position(119.29)));
    };
    navigator.geolocation.watchPosition = success => { watcher = success; window.testGpsStopped = false; return 0; };
    navigator.geolocation.clearWatch = () => { watcher = null; window.testGpsStopped = true; };
    window.testEmitGps = lon => watcher?.(position(lon));
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let releaseUpload = () => {};
  try {
    await jsonApi(context.request, 'POST', '/auth/register', { nickname: '定位流程回归', email: `gps-${suffix}@example.com`, password: `Gps-${suffix}` });
    await page.goto(BASE + '/#/record');
    await page.locator('.record-start').waitFor();
    await page.locator('.record-start').click();
    await page.locator('#record-status-message').filter({ hasText: '定位权限被拒绝' }).waitFor();
    assert.equal(await jsonApi(context.request, 'GET', '/tracks/active'), null, 'denied GPS must not create an empty recording');

    await page.evaluate(() => { window.testGpsDenied = false; });
    let uploadStarted;
    const started = new Promise(resolve => { uploadStarted = resolve; });
    const gate = new Promise(resolve => { releaseUpload = resolve; });
    let delayed = false;
    await page.route('**/api/tracks/*/points', async route => {
      if (!delayed) { delayed = true; uploadStarted(); await gate; }
      await route.continue();
    });
    await page.locator('.record-start').click();
    await started;
    await page.locator('#record-pending').filter({ hasText: '1' }).waitFor();
    // Respect the real sampling interval: a new fix arrives while the first upload is still in flight.
    await page.waitForTimeout(4600);
    await page.evaluate(() => window.testEmitGps(119.29006));
    await page.locator('#record-pending').filter({ hasText: '2' }).waitFor();
    await page.locator('.record-actions').getByRole('button', { name: /暂停/ }).click();
    assert.ok(await page.evaluate(() => window.testGpsStopped), 'pause must stop sampling even when the watcher identifier is zero');
    releaseUpload();
    await page.locator('.record-actions').getByRole('button', { name: /继续/ }).waitFor();
    assert.equal(await page.locator('#record-pending').textContent(), '0');
    assert.equal(await page.locator('#record-saved').textContent(), '2', 'both samples must remain after an in-flight upload');
    const active = await jsonApi(context.request, 'GET', '/tracks/active');
    assert.equal(active.status, 'paused');
    assert.equal(active.point_count, 2);
    await page.locator('.record-actions').getByRole('button', { name: '结束并保存' }).click();
    await page.locator('#edit-title').waitFor();
    const routeId = new URL(page.url()).hash.split('/').at(-1);
    const draft = await jsonApi(context.request, 'GET', `/routes/${routeId}`);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.private_track.point_count, 2);
    assert.deepEqual(errors, []);
    console.log('Recording passed: denied permission creates no session; watcher id 0; concurrent queued samples survive pause, sync and save.');
  } finally {
    releaseUpload();
    await context.close();
  }
}

async function insecureContext(browser) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  let created = 0;
  page.on('request', req => { if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/tracks') created++; });
  try {
    const insecureUrl = BASE.replace('127.0.0.1', 'citytrace.test').replace('localhost', 'citytrace.test');
    await page.goto(insecureUrl + '/#/record');
    await page.locator('.record-start').waitFor();
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    assert.ok(await page.locator('.record-start').isDisabled());
    assert.match(await page.locator('#record-status-message').textContent(), /HTTPS/);
    assert.equal(created, 0);
    console.log('Insecure phone access passed: HTTPS guidance is visible and GPS session creation is blocked.');
  } finally { await context.close(); }
}

async function offlineShell(browser) {
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  const page = await context.newPage();
  try {
    await page.goto(BASE + '/static/manifest.json');
    await page.evaluate(async () => {
      await (await caches.open('citytrace-shell-v1')).put('/auth/me', new Response('private legacy sentinel'));
      await (await caches.open('other-application-cache')).put('/unrelated', new Response('keep'));
    });
    await page.goto(BASE + '/#/discover');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    await page.waitForFunction(async () => !(await caches.keys()).includes('citytrace-shell-v1'));
    const cached = await page.evaluate(async () => {
      const keys = await caches.keys();
      const cache = await caches.open('citytrace-shell-v3');
      return { keys, paths: (await cache.keys()).map(req => new URL(req.url).pathname) };
    });
    assert.ok(cached.keys.includes('other-application-cache'), 'upgrading CityTrace must preserve unrelated caches');
    assert.ok(cached.paths.includes('/static/v2.js'), 'the offline shell must contain the V2 interaction layer');
    const response = await page.evaluate(async () => { const res = await fetch('/auth/me'); return res.status; });
    assert.equal(response, 401);
    await context.setOffline(true);
    const offline = await page.evaluate(async () => {
      let privateRejected = false;
      try { await fetch('/auth/me'); } catch { privateRejected = true; }
      const code = await (await fetch('/static/v2.js')).text();
      return { privateRejected, hasV2: code.includes('CityTrace V2 interaction layer') };
    });
    assert.equal(offline.privateRejected, true, 'private API aliases must never resolve from a shell cache');
    assert.equal(offline.hasV2, true);
    await page.reload();
    await page.locator('#app .empty-state').waitFor();
    assert.ok(await page.evaluate(() => typeof window.renderRecord === 'function'));
    console.log('Offline shell passed: V2 is available offline; private API aliases are not cached; old private cache is removed.');
  } finally { await context.close(); }
}

async function main() {
  assert.notEqual(new URL(BASE).port, '8002', 'Use an isolated test instance.');
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP citytrace.test 127.0.0.1'], ...(process.env.PLAYWRIGHT_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH } : {}) });
  try { await recordingLifecycle(browser); await insecureContext(browser); await offlineShell(browser); }
  finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
