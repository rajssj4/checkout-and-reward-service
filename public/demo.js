const $ = (id) => document.getElementById(id);
let cart = null;
let products = [];
let lastCheckout = null;
let busy = false;
const money = (minor) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(
    minor / 100,
  );
const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
function notice(message, error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
async function api(path, method = 'GET', body, key) {
  const started = Date.now();
  let data,
    status = 'NETWORK ERROR';
  try {
    const response = await fetch(path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    status = response.status;
    data = response.status === 204 ? null : await response.json();
    if (!response.ok)
      throw new Error(
        `${status} · ${data?.error?.code || 'REQUEST_FAILED'}: ${data?.error?.message || 'Request failed'}`,
      );
    return data;
  } catch (error) {
    if (!data)
      data = {
        message: error.message,
        note: 'Outcome may be unknown. Retry checkout using the saved request.',
      };
    throw error;
  } finally {
    const detail = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `${status} · ${method} ${path} · ${Date.now() - started} ms`;
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(
      { ...(key ? { idempotencyKey: key } : {}), response: data },
      null,
      2,
    );
    detail.append(summary, pre);
    $('activity').prepend(detail);
    while ($('activity').children.length > 40) $('activity').lastChild.remove();
  }
}
async function run(action) {
  if (busy) return;
  busy = true;
  document.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await action();
  } catch (error) {
    notice(error.message, true);
  } finally {
    busy = false;
    document.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}
function renderCart() {
  $('cart-id').textContent = cart
    ? `${cart.status} · ${cart.id}`
    : 'Create a cart to get started.';
  $('cart').innerHTML = cart?.items.length
    ? cart.items
        .map(
          (item) =>
            `<div class="row"><div><strong>${escape(item.name)}</strong><span>${money(item.unitPriceMinor)} each · ${item.availableInventory} available</span></div><div class="actions"><input aria-label="Quantity for ${escape(item.name)}" type="number" min="1" max="1000000" value="${item.quantity}" data-quantity="${escape(item.productId)}"><button data-update="${escape(item.productId)}">Update</button><button data-remove="${escape(item.productId)}">Remove</button></div><strong>${money(item.lineTotalMinor)}</strong></div>`,
        )
        .join('') + `<p><strong>Subtotal ${money(cart.grossMinor)}</strong></p>`
    : '<p>Your cart is empty. Add a product to begin.</p>';
}
async function refresh() {
  const [catalog, rewards, report] = await Promise.all([
    api('/products'),
    api('/admin/coupons'),
    api('/admin/reports/summary'),
  ]);
  products = catalog.products;
  $('products').innerHTML = products
    .map(
      (p) =>
        `<div class="row"><div><strong>${escape(p.name)}</strong><span>${money(p.unitPriceMinor)} · ${p.inventory} in stock</span></div><button data-add="${escape(p.id)}">Add to cart</button></div>`,
    )
    .join('');
  const selected = $('race-product').value;
  $('race-product').innerHTML = products
    .map(
      (p) =>
        `<option value="${escape(p.id)}">${escape(p.name)} (${p.inventory} left)</option>`,
    )
    .join('');
  if (products.some((p) => p.id === selected))
    $('race-product').value = selected;
  $('coupons').innerHTML = rewards.coupons.length
    ? rewards.coupons
        .map(
          (c) =>
            `<div class="row"><div><strong>${c.discountBps / 100}% off · ${escape(c.status)}</strong><span>Milestone ${c.milestoneNumber}</span><div class="code">${escape(c.code)}</div></div><button data-coupon="${escape(c.code)}">Use code</button></div>`,
        )
        .join('')
    : '<p>No coupons generated yet. Place orders, then request generation.</p>';
  const metrics = [
    ['Orders', report.successfulOrders],
    ['Gross revenue', money(report.grossRevenueMinor)],
    ['Discounts', money(report.totalDiscountsMinor)],
    ['Net revenue', money(report.netRevenueMinor)],
    ['Coupons generated', report.coupons.generated],
    [
      'Available / redeemed',
      `${report.coupons.available} / ${report.coupons.redeemed}`,
    ],
  ];
  $('report').innerHTML =
    '<div class="metrics">' +
    metrics
      .map(
        ([label, value]) =>
          `<div class="metric"><span>${label}</span><strong>${value}</strong></div>`,
      )
      .join('') +
    '</div>' +
    report.purchasedByProduct
      .map(
        (p) =>
          `<div class="row"><span>${escape(products.find((v) => v.id === p.productId)?.name || p.productId)}</span><strong>${p.quantity} purchased</strong></div>`,
      )
      .join('');
  if (cart) cart = await api(`/carts/${cart.id}`);
  renderCart();
}
function showOrder(order) {
  $('order-id').value = order.id;
  $('order').innerHTML =
    `<h3>Order receipt</h3><p class="code">${escape(order.id)}</p>` +
    order.items
      .map(
        (i) =>
          `<div class="row"><span>${escape(i.name)} × ${i.quantity}</span><strong>${money(i.lineTotalMinor)}</strong></div>`,
      )
      .join('') +
    `<p>Gross ${money(order.grossMinor)} − discount ${money(order.discountMinor)} = <strong>${money(order.netMinor)}</strong></p>`;
}
async function checkout(retry = false, twice = false) {
  if (retry) {
    if (!lastCheckout) throw new Error('No checkout request to retry yet.');
  } else {
    if (!cart) throw new Error('Create a cart first.');
    const code = $('coupon').value.trim();
    lastCheckout = {
      path: `/carts/${cart.id}/checkout`,
      key: crypto.randomUUID(),
      body: code ? { couponCode: code } : {},
    };
  }
  const { path, key, body } = lastCheckout;
  const results = await Promise.allSettled(
    Array.from({ length: twice ? 2 : 1 }, () => api(path, 'POST', body, key)),
  );
  const orders = results
    .filter((r) => r.status === 'fulfilled')
    .map((r) => r.value);
  if (orders.length) showOrder(orders[0]);
  const errors = results
    .filter((r) => r.status === 'rejected')
    .map((r) => r.reason.message);
  notice(
    errors.length
      ? errors.join(' | ')
      : twice
        ? `Both requests returned order ${orders[0].id}. Same order: ${orders[0].id === orders[1].id}.`
        : `Order ${orders[0].id} returned. Check the activity log for initial (201) or replay (200).`,
    errors.length > 0,
  );
  await refresh();
}
async function race(useCoupon) {
  const catalog = await api('/products');
  const product = catalog.products.find(
    (p) => p.id === $('race-product').value,
  );
  const code = $('coupon').value.trim();
  if (!product || product.inventory < (useCoupon ? 2 : 1))
    throw new Error(
      'Choose a product with enough remaining stock for this experiment.',
    );
  if (useCoupon && !code)
    throw new Error('Enter an available coupon in the cart section first.');
  const carts = await Promise.all([
    api('/carts', 'POST', {}),
    api('/carts', 'POST', {}),
  ]);
  await Promise.all(
    carts.map((c) =>
      api(`/carts/${c.id}/items/${encodeURIComponent(product.id)}`, 'PUT', {
        quantity: useCoupon ? 1 : product.inventory,
      }),
    ),
  );
  const results = await Promise.allSettled(
    carts.map((c) =>
      api(
        `/carts/${c.id}/checkout`,
        'POST',
        useCoupon ? { couponCode: code } : {},
        crypto.randomUUID(),
      ),
    ),
  );
  $('race-result').textContent = results
    .map(
      (r, i) =>
        `Customer ${i + 1} · cart ${carts[i].id}\n${r.status === 'fulfilled' ? `SUCCESS · order ${r.value.id} · ${money(r.value.netMinor)}` : r.reason.message}`,
    )
    .join('\n\n');
  notice(
    'Experiment finished. Compare both outcomes below and the refreshed stock and report.',
  );
  await refresh();
}
$('new-cart').onclick = () =>
  run(async () => {
    cart = await api('/carts', 'POST', {});
    renderCart();
    notice('New cart created.');
  });
$('refresh').onclick = () =>
  run(async () => {
    await refresh();
    notice('Store refreshed.');
  });
$('checkout').onclick = () => run(() => checkout());
$('retry').onclick = () => run(() => checkout(true));
$('double').onclick = () => run(() => checkout(false, true));
$('generate').onclick = () =>
  run(async () => {
    const coupon = await api('/admin/coupons', 'POST', {});
    await refresh();
    notice(`Coupon generated: ${coupon.code}`);
  });
$('stock-race').onclick = () => run(() => race(false));
$('coupon-race').onclick = () => run(() => race(true));
$('clear').onclick = () => {
  $('activity').replaceChildren();
};
$('lookup').onsubmit = (event) => {
  event.preventDefault();
  run(async () => {
    showOrder(
      await api(`/orders/${encodeURIComponent($('order-id').value.trim())}`),
    );
    notice('Saved order retrieved.');
  });
};
document.addEventListener('click', (event) => {
  const button = event.target.closest('button');
  if (!button || busy) return;
  if (button.dataset.coupon) {
    $('coupon').value = button.dataset.coupon;
    notice('Coupon selected. It will be validated at checkout.');
  }
  if (button.dataset.add)
    run(async () => {
      if (!cart || cart.status !== 'OPEN')
        cart = await api('/carts', 'POST', {});
      const id = button.dataset.add;
      cart = await api(
        `/carts/${cart.id}/items/${encodeURIComponent(id)}`,
        'PUT',
        {
          quantity:
            (cart.items.find((i) => i.productId === id)?.quantity || 0) + 1,
        },
      );
      renderCart();
      notice('Cart updated.');
    });
  if (button.dataset.update)
    run(async () => {
      const id = button.dataset.update;
      const input = [...document.querySelectorAll('[data-quantity]')].find(
        (el) => el.dataset.quantity === id,
      );
      cart = await api(
        `/carts/${cart.id}/items/${encodeURIComponent(id)}`,
        'PUT',
        { quantity: Number(input.value) },
      );
      renderCart();
      notice('Quantity updated.');
    });
  if (button.dataset.remove)
    run(async () => {
      await api(
        `/carts/${cart.id}/items/${encodeURIComponent(button.dataset.remove)}`,
        'DELETE',
      );
      cart = await api(`/carts/${cart.id}`);
      renderCart();
      notice('Item removed.');
    });
});
run(async () => {
  await refresh();
  notice('Ready. Add a product to create your first cart.');
});
