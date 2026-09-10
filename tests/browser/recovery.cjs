// Requires a fresh, seeded evaluation database (n=5, discount=1000 bps).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.BROWSER_EXECUTABLE,
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const wait = () =>
      page.waitForFunction(() => !document.querySelector('#refresh').disabled);
    const click = async (s) => {
      await page.click(s);
      await wait();
    };
    const message = () => page.locator('#notice').innerText();
    await page.goto(process.env.BROWSER_BASE_URL || 'http://127.0.0.1:33003');
    await wait();
    await click('#retry');
    assert.match(await message(), /No checkout request/);
    await click('#new-cart');
    await click('#checkout');
    assert.match(await message(), /EMPTY_CART/);
    await click('[data-add="mug"]');
    for (const value of ['0', '-1', '1.5', '1000001']) {
      await page.locator('[data-quantity="mug"]').fill(value);
      await click('[data-update="mug"]');
      assert.match(await message(), /VALIDATION_ERROR/);
    }
    await page.locator('[data-quantity="mug"]').fill('999');
    await click('[data-update="mug"]');
    assert.match(await message(), /INSUFFICIENT_INVENTORY/);
    await page.locator('[data-quantity="mug"]').fill('1');
    await click('[data-update="mug"]');
    const cart = await page.locator('#cart-id').innerText();
    await page.reload();
    await wait();
    assert.equal(await page.locator('#cart-id').innerText(), cart);
    await page.fill('#coupon', 'invalid-code');
    await click('#checkout');
    assert.match(await message(), /COUPON_INVALID/);
    await page.fill('#coupon', '');
    let committed;
    await page.route(
      '**/checkout',
      async (route) => {
        const response = await route.fetch();
        committed = await response.json();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await click('#checkout');
    assert.match(await message(), /may have succeeded/);
    await page.reload();
    await wait();
    await click('#retry');
    assert.equal(await page.inputValue('#order-id'), committed.id);
    assert.match(await page.locator('#activity').innerText(), /200 · POST/);
    await click('#checkout');
    assert.match(await message(), /CART_ALREADY_CHECKED_OUT/);
    await click('[data-add="mug"]');
    await page.route(
      '**/admin/reports/summary',
      (r) =>
        r.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { code: 'SERVICE_BUSY', message: 'Test report unavailable' },
          }),
        }),
      { times: 1 },
    );
    await click('#checkout');
    assert.match(await message(), /Order .* returned.*Store refresh failed/s);
    assert.match(await page.locator('#order').innerText(), /Order receipt/);
    await click('#refresh');
    assert.equal(await message(), 'Store refreshed.');
    await page.fill('#order-id', 'bad-id');
    await click('#lookup button');
    assert.match(await message(), /VALIDATION_ERROR/);
    await page.fill('#order-id', '00000000-0000-4000-8000-000000000000');
    await click('#lookup button');
    assert.match(await message(), /ORDER_NOT_FOUND/);
    await click('#clear');
    assert.equal(await page.locator('#activity').innerText(), '');
    for (const width of [390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
    assert.deepEqual(errors, []);
    console.log(
      'PASS: empty cart, invalid quantities, excess stock, invalid coupon, reload recovery, committed-but-lost response and exact replay, duplicate cart, refresh failure after success, invalid/missing order, log clearing, responsive widths.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
