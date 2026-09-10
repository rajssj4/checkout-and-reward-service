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
const schema = `checkout_${randomUUID().replaceAll('-', '')}`;
const admin = openDatabase(url);
const db = openDatabase(url, schema);
const otherDb = openDatabase(url, schema);
const app = createApp({ db, currency: 'USD' });
const otherApp = createApp({ db: otherDb, currency: 'USD' });

beforeAll(async () => {
  await admin.schema.createSchema(schema);
  await migrate(db, readConfig({ DATABASE_URL: url }));
}, 15000);
beforeEach(async () => {
  await db.raw('TRUNCATE order_items, orders, cart_items, carts, products');
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

async function cart(items: [string, number][] = [['coffee', 2]]) {
  const id = (await request(app).post('/carts').send({}).expect(201)).body
    .id as string;
  for (const [productId, quantity] of items) {
    await request(app)
      .put(`/carts/${id}/items/${productId}`)
      .send({ quantity })
      .expect(200);
  }
  return id;
}
function checkout(id: string, key: string, target = app, body = {}) {
  return request(target)
    .post(`/carts/${id}/checkout`)
    .set('Idempotency-Key', key)
    .send(body);
}

describe('atomic checkout and orders', () => {
  it('uses current prices, snapshots every item, and replays durable results through another pool', async () => {
    const id = await cart([
      ['coffee', 2],
      ['notebook', 3],
    ]);
    await db('products')
      .where({ id: 'coffee' })
      .update({ unit_price_minor: 1301 });
    const key = randomUUID();
    const placed = await checkout(id, key).expect(201);
    expect(placed.headers.location).toBe(`/orders/${placed.body.id}`);
    expect(placed.body).toMatchObject({
      cartId: id,
      currency: 'USD',
      grossMinor: 4105,
      discountBps: 0,
      discountMinor: 0,
      netMinor: 4105,
    });
    expect(placed.body.items).toEqual([
      {
        productId: 'coffee',
        name: 'Coffee beans',
        unitPriceMinor: 1301,
        quantity: 2,
        lineTotalMinor: 2602,
      },
      {
        productId: 'notebook',
        name: 'Notebook',
        unitPriceMinor: 501,
        quantity: 3,
        lineTotalMinor: 1503,
      },
    ]);
    await db('products')
      .where({ id: 'coffee' })
      .update({ name: 'Changed name', unit_price_minor: 9999 });
    expect(
      (await request(otherApp).get(`/orders/${placed.body.id}`).expect(200))
        .body,
    ).toEqual(placed.body);
    expect(
      (await checkout(id.toUpperCase(), key, otherApp).expect(200)).body,
    ).toEqual(placed.body);
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(18);
    expect((await db('carts').where({ id }).first()).status).toBe(
      'CHECKED_OUT',
    );
    expect(await db('orders').count('* as count').first()).toEqual({
      count: '1',
    });
    await request(app)
      .put(`/carts/${id}/items/coffee`)
      .send({ quantity: 3 })
      .expect(409);
  });

  it('coalesces concurrent same-key requests into one order', async () => {
    const id = await cart();
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        checkout(id, key, i % 2 ? app : otherApp),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 200)).toHaveLength(7);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(18);
    expect(await db('orders').count('* as count').first()).toEqual({
      count: '1',
    });
  });

  it('rejects different keys on the same cart and includes the existing order ID', async () => {
    const id = await cart();
    const results = await Promise.all([
      checkout(id, randomUUID()),
      checkout(id, randomUUID(), otherApp),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const winner = results.find((r) => r.status === 201)!;
    expect(results.find((r) => r.status === 409)!.body.error).toMatchObject({
      code: 'CART_ALREADY_CHECKED_OUT',
      details: { orderId: winner.body.id },
    });
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(18);
  });

  it('rejects a shared key across different carts or changed coupon input', async () => {
    const ids = await Promise.all([cart(), cart()]);
    const key = randomUUID();
    const results = await Promise.all([
      checkout(ids[0]!, key),
      checkout(ids[1]!, key, otherApp),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
      'IDEMPOTENCY_KEY_REUSED',
    );
    const winner = results.find((r) => r.status === 201)!;
    expect(
      (
        await checkout(winner.body.cartId, key, app, {
          couponCode: 'different',
        }).expect(409)
      ).body.error.code,
    ).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(18);
  });

  it('allows only one customer to buy the last unit', async () => {
    const ids = await Promise.all([
      cart([['limited-print', 1]]),
      cart([['limited-print', 1]]),
    ]);
    const results = await Promise.all([
      checkout(ids[0]!, randomUUID()),
      checkout(ids[1]!, randomUUID(), otherApp),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body.error.code).toBe(
      'INSUFFICIENT_INVENTORY',
    );
    expect(
      (await db('products').where({ id: 'limited-print' }).first()).inventory,
    ).toBe(0);
    expect(await db('orders').count('* as count').first()).toEqual({
      count: '1',
    });
    expect(
      await db('carts').where({ status: 'OPEN' }).count('* as count').first(),
    ).toEqual({ count: '1' });
  });

  it('rechecks stock and permits retry after a failed attempt', async () => {
    const id = await cart([
      ['coffee', 2],
      ['tea', 1],
    ]);
    const key = randomUUID();
    await db('products').where({ id: 'tea' }).update({ inventory: 0 });
    await checkout(id, key).expect(409);
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(20);
    expect(await db('orders').select('*')).toEqual([]);
    expect((await db('carts').where({ id }).first()).status).toBe('OPEN');
    await db('products').where({ id: 'tea' }).update({ inventory: 1 });
    await checkout(id, key).expect(201);
  });

  it('rolls back inventory, snapshots, order, and cart when COMMIT fails', async () => {
    const id = await cart([
      ['coffee', 2],
      ['tea', 1],
    ]);
    const key = randomUUID();
    await db.raw(`CREATE FUNCTION reject_test_order() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected commit failure'; END; $$`);
    await db.raw(`CREATE CONSTRAINT TRIGGER fail_test_commit AFTER INSERT ON orders
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_test_order()`);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await checkout(id, key).expect(500)).body.error.code).toBe(
        'INTERNAL_ERROR',
      );
      expect(await db('orders').select('*')).toEqual([]);
      expect(await db('order_items').select('*')).toEqual([]);
      expect(
        (await db('products').where({ id: 'coffee' }).first()).inventory,
      ).toBe(20);
      expect(
        (await db('products').where({ id: 'tea' }).first()).inventory,
      ).toBe(30);
      expect((await db('carts').where({ id }).first()).status).toBe('OPEN');
    } finally {
      log.mockRestore();
      await db.raw('DROP TRIGGER fail_test_commit ON orders');
      await db.raw('DROP FUNCTION reject_test_order()');
    }
    await checkout(id, key).expect(201);
  });

  it('coordinates edits with checkout using the cart lock', async () => {
    const id = await cart([['coffee', 1]]);
    const [purchase, edit] = await Promise.all([
      checkout(id, randomUUID()),
      request(otherApp).put(`/carts/${id}/items/coffee`).send({ quantity: 3 }),
    ]);
    expect(purchase.status).toBe(201);
    expect([200, 409]).toContain(edit.status);
    const quantity = edit.status === 200 ? 3 : 1;
    expect(purchase.body.items[0].quantity).toBe(quantity);
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(20 - quantity);
  });

  it('returns a retryable lock timeout and preserves the checkout key for retry', async () => {
    const id = await cart();
    const key = randomUUID();
    const blocker = await otherDb.transaction();
    try {
      await blocker('carts').where({ id }).forUpdate().first();
      const busy = await checkout(id, key).expect(503);
      expect(busy.body.error.code).toBe('SERVICE_BUSY');
      expect(busy.headers['retry-after']).toBe('1');
      expect(await db('orders').select('*')).toEqual([]);
      expect(
        (await db('products').where({ id: 'coffee' }).first()).inventory,
      ).toBe(20);
    } finally {
      await blocker.rollback();
    }
    await checkout(id, key).expect(201);
  });

  it('returns useful validation, missing-resource, empty-cart, and coupon errors', async () => {
    const id = await cart([]);
    await request(app).post(`/carts/${id}/checkout`).send({}).expect(400);
    await checkout(id, 'key with spaces').expect(400);
    await checkout(id, 'x'.repeat(129)).expect(400);
    await checkout(id, randomUUID(), app, { extra: true }).expect(400);
    expect((await checkout(id, randomUUID()).expect(409)).body.error.code).toBe(
      'EMPTY_CART',
    );
    expect(
      (await checkout(randomUUID(), randomUUID()).expect(404)).body.error.code,
    ).toBe('CART_NOT_FOUND');
    expect(
      (await request(app).get(`/orders/${randomUUID()}`).expect(404)).body.error
        .code,
    ).toBe('ORDER_NOT_FOUND');
    const filled = await cart();
    expect(
      (
        await checkout(filled, randomUUID(), app, { couponCode: 'ANY' }).expect(
          409,
        )
      ).body.error.code,
    ).toBe('COUPON_INVALID');
    expect(await db('orders').select('*')).toEqual([]);
  });

  it('rejects unsafe checkout amounts without consuming inventory', async () => {
    const id = await cart();
    await db('products')
      .where({ id: 'coffee' })
      .update({ unit_price_minor: '9007199254740991' });
    expect((await checkout(id, randomUUID()).expect(400)).body.error.code).toBe(
      'AMOUNT_OUT_OF_RANGE',
    );
    expect(
      (await db('products').where({ id: 'coffee' }).first()).inventory,
    ).toBe(20);
    expect(await db('orders').select('*')).toEqual([]);
    expect((await db('carts').where({ id }).first()).status).toBe('OPEN');
  });
});
