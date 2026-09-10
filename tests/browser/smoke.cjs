// Requires a fresh, seeded evaluation database (n=5, discount=1000 bps).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
  });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const wait = () =>
    page.waitForFunction(() => !document.querySelector('#refresh').disabled);
  const click = async (selector) => {
    await page.locator(selector).click();
    await wait();
  };
  await page.goto(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:33003');
  await wait();
  await click('[data-add="coffee"]');
  await page.locator('[data-quantity="coffee"]').fill('2');
  await click('[data-update="coffee"]');
  assert.match(await page.locator('#cart').innerText(), /25.98/);
  await click('[data-add="tea"]');
  await click('[data-remove="tea"]');
  await click('#double');
  assert.match(await page.locator('#notice').innerText(), /Same order: true/);
  const id = await page.locator('#order-id').inputValue();
  await click('#retry');
  assert.equal(await page.locator('#order-id').inputValue(), id);
  await click('#lookup button');
  await click('#generate');
  assert.match(
    await page.locator('#notice').innerText(),
    /NO_ELIGIBLE_MILESTONE/,
  );
  for (let i = 0; i < 4; i++) {
    await click('[data-add="coffee"]');
    await click('#checkout');
  }
  await click('#generate');
  await click('[data-coupon]');
  await page.locator('#race-product').selectOption('tea');
  await click('#coupon-race');
  const couponRace = await page.locator('#race-result').innerText();
  assert.equal((couponRace.match(/SUCCESS/g) || []).length, 1);
  assert.match(couponRace, /COUPON_ALREADY_REDEEMED/);
  await page.locator('#race-product').selectOption('limited-print');
  await click('#stock-race');
  const stockRace = await page.locator('#race-result').innerText();
  assert.equal((stockRace.match(/SUCCESS/g) || []).length, 1);
  assert.match(stockRace, /INSUFFICIENT_INVENTORY/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    'PASS: cart editing, double checkout, retry, order lookup, milestone generation, coupon contention, stock contention, mobile layout, no browser errors.',
  );
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
