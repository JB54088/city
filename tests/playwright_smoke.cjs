const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const baseUrl = process.env.CITYTRACE_URL || 'http://127.0.0.1:8002';

(async () => {
  const launchOptions = { headless: true };
  if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
  const browser = await chromium.launch(launchOptions);
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  try {
    const response = await page.goto(baseUrl, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200, 'home page should load');
    await page.getByRole('heading', { name: '发现城市路线' }).waitFor();
    const apiResponse = await page.request.get(`${baseUrl}/api/routes`);
    assert.equal(apiResponse.status(), 200, 'public route API should respond');
    const listing = await apiResponse.json();
    assert.ok(listing.data.items.length, 'demo mode should seed a published route');
    const route = listing.data.items[0];
    const configResponse = await page.request.get(`${baseUrl}/api/config`);
    const mapConfigured = Boolean((await configResponse.json()).data.amap_key);

    await page.goto(`${baseUrl}/#/route/${route.id}`, { waitUntil: 'networkidle' });
    await page.locator('.detail-map[data-v2-map="1"]').waitFor();
    assert.ok(await page.locator('.timeline-item').count(), 'route detail should render its ordered timeline');
    await page.locator('.timeline-item').first().click();
    assert.ok(await page.locator('.timeline-item.is-active').count(), 'timeline selection should update the active waypoint');
    if (!mapConfigured) assert.ok(await page.locator('.v2-map-help').count(), 'missing provider key should be disclosed as a coordinate sketch');
    else await page.locator('.detail-map.has-real-map').waitFor({ timeout: 15000 });

    if (await page.locator('.timeline-item .photo-thumb').count()) {
      await page.locator('.timeline-item .photo-thumb').first().click();
      await page.locator('.v2-lightbox').waitFor();
      await page.locator('.v2-lightbox').click();
    }

    await page.setViewportSize({ width: 390, height: 844 });
    const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(horizontalOverflow, false, 'mobile route detail should not overflow horizontally');
    assert.equal(await page.locator('.v2-route-actions').count(), route.status === 'published' ? 1 : 0);

    await page.goto(`${baseUrl}/#/record`, { waitUntil: 'networkidle' });
    await page.locator('.record-map').waitFor();
    assert.equal(await page.locator('.record-map svg').count(), 0, 'empty recording screen must not draw invented GPS');
    assert.deepEqual(pageErrors, [], `browser runtime errors: ${pageErrors.join('; ')}`);
    console.log(`Playwright smoke passed: ${route.title}; mobile width 390px; no browser exceptions.`);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
