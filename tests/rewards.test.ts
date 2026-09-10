import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.',
  );
const schema = `rewards_${randomUUID().replaceAll('-', '')}`;
const admin = openDatabase(url);
const db = openDatabase(url, schema);
const otherDb = openDatabase(url, schema);
const app = createApp({ db, currency: 'USD' });
const otherApp = createApp({ db: otherDb, currency: 'USD' });
beforeAll(async () => {
  await admin.schema.createSchema(schema);
  await migrate(
    db,
    readConfig({ DATABASE_URL: url, REWARD_EVERY_N_ORDERS: '2' }),
  );
}, 15000);
beforeEach(async () => {
  await db.raw(
    'TRUNCATE order_items, orders, cart_items, carts, products, coupons',
  );
  await db('settings')
    .where({ id: 1 })
    .update({ reward_every_n_orders: 2, discount_bps: 1000 });
  await seed(db);
});
afterAll(async () => {
  await Promise.all([db.destroy(), otherDb.destroy()]);
  try {
    await admin.schema.dropSchemaIfExists(schema, true);
  } finally {
    await admin.destroy();
  }
});
async function cart(productId = 'coffee', quantity = 1) {
  const id = (await request(app).post('/carts').send({}).expect(201)).body
    .id as string;
  await request(app)
    .put(`/carts/${id}/items/${productId}`)
    .send({ quantity })
    .expect(200);
  return id;
}
function checkout(
  id: string,
  couponCode?: string,
  target = app,
  key = randomUUID(),
) {
  return request(target)
    .post(`/carts/${id}/checkout`)
    .set('Idempotency-Key', key)
    .send(couponCode ? { couponCode } : {});
}
async function buy(product = 'coffee', quantity = 1) {
  return (await checkout(await cart(product, quantity)).expect(201)).body;
}
async function availableCoupon() {
  await buy();
  await buy();
  return (await request(app).post('/admin/coupons').send({}).expect(201)).body;
}
async function list() {
  return (await request(app).get('/admin/coupons').expect(200)).body.coupons;
}

describe('coupon milestones and redemption', () => {
  it('requires a successful milestone and generates it only once', async () => {
    expect(
      (await request(app).post('/admin/coupons').send({}).expect(409)).body
        .error.code,
    ).toBe('NO_ELIGIBLE_MILESTONE');
    await buy();
    await request(app).post('/admin/coupons').send({}).expect(409);
    const failedCart = await cart();
    await checkout(failedCart, 'unknown').expect(409);
    await request(app).post('/admin/coupons').send({}).expect(409);
    await buy();
    expect(await list()).toEqual([]);
    const generated = (
      await request(app).post('/admin/coupons').send({}).expect(201)
    ).body;
    expect(generated).toMatchObject({
      milestoneNumber: 1,
      discountBps: 1000,
      status: 'AVAILABLE',
      redeemedOrderId: null,
    });
    await request(app).post('/admin/coupons').send({}).expect(409);
    expect(await list()).toEqual([generated]);
  });

  it('allocates a backlog once per milestone under competing generation requests', async () => {
    for (let i = 0; i < 6; i++) await buy();
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        request(i % 2 ? app : otherApp)
          .post('/admin/coupons')
          .send({}),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(2);
    expect(
      (await list()).map((c: { milestoneNumber: number }) => c.milestoneNumber),
    ).toEqual([1, 2, 3]);
  });

  it('redeems once across competing carts without changing the loser', async () => {
    const coupon = await availableCoupon();
    const ids = [await cart('coffee', 2), await cart('tea', 1)];
    const results = await Promise.all([
      checkout(ids[0]!, coupon.code),
      checkout(ids[1]!, coupon.code, otherApp),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
      'COUPON_ALREADY_REDEEMED',
    );
    const winner = results.find((r) => r.status === 201)!.body;
    expect(winner.coupon).toEqual({ id: coupon.id, code: coupon.code });
    expect((await list())[0]).toMatchObject({
      status: 'REDEEMED',
      redeemedOrderId: winner.id,
    });
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(winner.cartId === ids[0] ? 16 : 18);
    expect((await db('products').where({ id: 'tea' }).first()).inventory).toBe(
      winner.cartId === ids[1] ? 29 : 30,
    );
    const loserId = winner.cartId === ids[0] ? ids[1] : ids[0];
    expect((await db('carts').where({ id: loserId }).first()).status).toBe(
      'OPEN',
    );
  });

  it('normalizes coupon input and replays a discounted order without redeeming twice', async () => {
    const coupon = await availableCoupon();
    const id = await cart('notebook', 3);
    const key = randomUUID();
    const order = (
      await checkout(id, `  ${coupon.code}  `, app, key).expect(201)
    ).body;
    expect(order).toMatchObject({
      grossMinor: 1503,
      discountMinor: 150,
      netMinor: 1353,
      discountBps: 1000,
    });
    expect(
      (await checkout(id, coupon.code, otherApp, key).expect(200)).body,
    ).toEqual(order);
    expect(
      (await request(app).get(`/orders/${order.id}`).expect(200)).body,
    ).toEqual(order);
    expect(
      await db('orders').whereNotNull('coupon_id').count('* as count').first(),
    ).toEqual({ count: '1' });
  });

  it('leaves a coupon available after insufficient inventory and after a commit failure', async () => {
    const coupon = await availableCoupon();
    const id = await cart('tea', 1);
    const key = randomUUID();
    await db('products').where({ id: 'tea' }).update({ inventory: 0 });
    await checkout(id, coupon.code, app, key).expect(409);
    expect((await list())[0].status).toBe('AVAILABLE');
    await db('products').where({ id: 'tea' }).update({ inventory: 30 });
    await db.raw(`CREATE FUNCTION reject_coupon_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected coupon commit failure'; END; $$`);
    await db.raw(`CREATE CONSTRAINT TRIGGER fail_coupon_commit AFTER INSERT ON orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_coupon_commit()`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await checkout(id, coupon.code, app, key).expect(500);
      expect((await list())[0].status).toBe('AVAILABLE');
      expect(
        (await db('products').where({ id: 'tea' }).first()).inventory,
      ).toBe(30);
      expect((await db('carts').where({ id }).first()).status).toBe('OPEN');
      expect(await db('orders').count('* as count').first()).toEqual({
        count: '2',
      });
    } finally {
      log.mockRestore();
      await db.raw('DROP TRIGGER fail_coupon_commit ON orders');
      await db.raw('DROP FUNCTION reject_coupon_commit()');
    }
    await checkout(id, coupon.code, app, key).expect(201);
  });

  it.each([0, 10000])(
    'supports a %i basis-point coupon without negative totals',
    async (rate) => {
      await db('settings').where({ id: 1 }).update({ discount_bps: rate });
      const coupon = await availableCoupon();
      const order = (
        await checkout(await cart('notebook'), coupon.code).expect(201)
      ).body;
      expect(order.discountMinor).toBe(rate === 0 ? 0 : 501);
      expect(order.netMinor).toBe(rate === 0 ? 501 : 0);
      expect((await list())[0].status).toBe('REDEEMED');
    },
  );

  it('rounds once on the order subtotal and counts discounted orders toward milestones', async () => {
    await db('settings').where({ id: 1 }).update({ discount_bps: 5000 });
    const coupon = await availableCoupon();
    const id = await cart('coffee');
    await request(app)
      .put(`/carts/${id}/items/notebook`)
      .send({ quantity: 1 })
      .expect(200);
    const order = (await checkout(id, coupon.code).expect(201)).body;
    expect(order).toMatchObject({
      grossMinor: 1800,
      discountMinor: 900,
      netMinor: 900,
    });
    await buy();
    expect(
      (await request(app).post('/admin/coupons').send({}).expect(201)).body
        .milestoneNumber,
    ).toBe(2);
  });
});

describe('read-only reconciled reporting', () => {
  async function summary() {
    return (await request(app).get('/admin/reports/summary').expect(200)).body;
  }
  it('returns zero totals and all seeded products before any sale', async () => {
    const report = await summary();
    expect(report).toMatchObject({
      grossRevenueMinor: 0,
      totalDiscountsMinor: 0,
      netRevenueMinor: 0,
      successfulOrders: 0,
      coupons: { generated: 0, available: 0, redeemed: 0 },
    });
    expect(report.purchasedByProduct).toHaveLength(5);
    expect(
      report.purchasedByProduct.every(
        (p: { quantity: number }) => p.quantity === 0,
      ),
    ).toBe(true);
  });

  it('reconciles orders and coupons without multiplying multi-item orders or counting retries', async () => {
    const firstCart = await cart('coffee', 2);
    await request(app)
      .put(`/carts/${firstCart}/items/tea`)
      .send({ quantity: 1 })
      .expect(200);
    const first = (await checkout(firstCart).expect(201)).body;
    const second = await buy('mug');
    const coupon = (
      await request(app).post('/admin/coupons').send({}).expect(201)
    ).body;
    const id = await cart('notebook', 3);
    const key = randomUUID();
    const third = (await checkout(id, coupon.code, app, key).expect(201)).body;
    await checkout(id, coupon.code, otherApp, key).expect(200);
    await checkout(await cart('tea'), coupon.code).expect(409);
    const fourth = await buy('mug');
    await request(app).post('/admin/coupons').send({}).expect(201);
    const before = {
      orders: await db('orders').orderBy('id'),
      products: await db('products').orderBy('id'),
      coupons: await list(),
      carts: await db('carts').orderBy('id'),
    };
    const report = await summary();
    expect(report).toMatchObject({
      grossRevenueMinor: 6848,
      totalDiscountsMinor: 150,
      netRevenueMinor: 6698,
      successfulOrders: 4,
      coupons: { generated: 2, available: 1, redeemed: 1 },
    });
    expect(report.purchasedByProduct).toEqual([
      { productId: 'coffee', quantity: 2 },
      { productId: 'limited-print', quantity: 0 },
      { productId: 'mug', quantity: 2 },
      { productId: 'notebook', quantity: 3 },
      { productId: 'tea', quantity: 1 },
    ]);
    const orders = [first, second, third, fourth];
    expect(report.grossRevenueMinor).toBe(
      orders.reduce((sum, o) => sum + o.grossMinor, 0),
    );
    expect(report.netRevenueMinor).toBe(
      report.grossRevenueMinor - report.totalDiscountsMinor,
    );
    expect(await summary()).toEqual(report);
    expect({
      orders: await db('orders').orderBy('id'),
      products: await db('products').orderBy('id'),
      coupons: await list(),
      carts: await db('carts').orderBy('id'),
    }).toEqual(before);
  });
});
