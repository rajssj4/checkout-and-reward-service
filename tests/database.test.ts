import request from 'supertest';
import { createApp } from '../src/app.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig } from '../src/config.js';
import { openDatabase } from '../src/db/connection.js';
import { assertSettings, migrate } from '../src/db/migrate.js';
import { seed } from '../src/db/seed.js';

const url = process.env.TEST_DATABASE_URL;
if (!url)
  throw new Error(
    'Set TEST_DATABASE_URL to a dedicated PostgreSQL test database.',
  );
const schema = `test_${randomUUID().replaceAll('-', '')}`;
const admin = openDatabase(url);
const db = openDatabase(url, schema);
const config = readConfig({ DATABASE_URL: url });

beforeAll(async () => {
  await admin.schema.createSchema(schema);
}, 15000);
afterAll(async () => {
  await db.destroy();
  try {
    await admin.schema.dropSchemaIfExists(schema, true);
  } finally {
    await admin.destroy();
  }
});

describe('PostgreSQL foundation', () => {
  it('repeats migrations and seeds without restoring inventory', async () => {
    await migrate(db, config);
    await seed(db);
    await db('products')
      .where({ id: 'limited-print' })
      .update({ inventory: 0 });
    await migrate(db, config);
    await seed(db);
    expect(await db('products').count('* as count').first()).toEqual({
      count: '5',
    });
    expect(
      (await db('products').where({ id: 'limited-print' }).first()).inventory,
    ).toBe(0);
    await expect(
      migrate(db, { ...config, DISCOUNT_BPS: 2000 }),
    ).rejects.toThrow(/differs/);
    await expect(assertSettings(db, config)).resolves.toBeUndefined();
    await expect(
      db('products').where({ id: 'coffee' }).update({ inventory: -1 }),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rolls back a failed transaction', async () => {
    await migrate(db, config);
    await seed(db);
    const before = await db('products').where({ id: 'tea' }).first();
    await expect(
      db.transaction(async (trx) => {
        await trx('products').where({ id: 'tea' }).decrement('inventory', 1);
        throw new Error('Injected failure');
      }),
    ).rejects.toThrow('Injected failure');
    expect(await db('products').where({ id: 'tea' }).first()).toEqual(before);
  });
});

describe('product and cart HTTP APIs', () => {
  const app = createApp({ db, currency: 'USD' });
  beforeAll(async () => {
    await migrate(db, config);
    await seed(db);
  });
  async function newCart() {
    const response = await request(app).post('/carts').send({}).expect(201);
    expect(response.headers.location).toBe(`/carts/${response.body.id}`);
    return response.body.id as string;
  }

  it('lists products and supports absolute quantity updates and repeatable deletion', async () => {
    const products = (await request(app).get('/products').expect(200)).body
      .products;
    expect(products).toHaveLength(5);
    expect(
      products.find((p: { id: string }) => p.id === 'notebook').unitPriceMinor,
    ).toBe(501);
    const id = await newCart();
    const endpoint = `/carts/${id}/items/notebook`;
    await request(app).put(endpoint).send({ quantity: 2 }).expect(200);
    const updated = await request(app)
      .put(endpoint)
      .send({ quantity: 2 })
      .expect(200);
    expect(updated.body.items).toHaveLength(1);
    expect(updated.body.grossMinor).toBe(1002);
    expect(updated.body.items[0]).toMatchObject({
      quantity: 2,
      isAvailable: true,
      lineTotalMinor: 1002,
    });
    expect(
      (await db('products').where({ id: 'notebook' }).first()).inventory,
    ).toBe(15);
    await request(app).delete(endpoint).expect(204);
    await request(app).delete(endpoint).expect(204);
    expect(
      (await request(app).get(`/carts/${id}`).expect(200)).body.items,
    ).toEqual([]);
  });

  it('rejects invalid products, quantities, missing carts, and excess stock without changing the cart', async () => {
    const id = await newCart();
    for (const quantity of [0, -1, 1.5, '2', 1000001]) {
      expect(
        (
          await request(app)
            .put(`/carts/${id}/items/coffee`)
            .send({ quantity })
            .expect(400)
        ).body.error.code,
      ).toBe('VALIDATION_ERROR');
    }
    await request(app)
      .put(`/carts/${id}/items/coffee`)
      .send({ quantity: 1, extra: true })
      .expect(400);
    expect(
      (
        await request(app)
          .put(`/carts/${id}/items/missing`)
          .send({ quantity: 1 })
          .expect(404)
      ).body.error.code,
    ).toBe('PRODUCT_NOT_FOUND');
    expect(
      (
        await request(app)
          .put(`/carts/${id}/items/coffee`)
          .send({ quantity: 21 })
          .expect(409)
      ).body.error.code,
    ).toBe('INSUFFICIENT_INVENTORY');
    expect(
      (await request(app).get(`/carts/${randomUUID()}`).expect(404)).body.error
        .code,
    ).toBe('CART_NOT_FOUND');
    await request(app).get('/carts/not-a-uuid').expect(400);
    await request(app).post('/carts').send({ extra: true }).expect(400);
    expect(
      (await request(app).get(`/carts/${id}`).expect(200)).body.items,
    ).toEqual([]);
  });

  it('shows current prices and stock warnings without reserving inventory', async () => {
    const id = await newCart();
    await request(app)
      .put(`/carts/${id}/items/mug`)
      .send({ quantity: 2 })
      .expect(200);
    const before = await db('products').where({ id: 'mug' }).first();
    try {
      await db('products')
        .where({ id: 'mug' })
        .update({ unit_price_minor: 1001, inventory: 1 });
      const cart = (await request(app).get(`/carts/${id}`).expect(200)).body;
      expect(cart.grossMinor).toBe(2002);
      expect(cart.items[0]).toMatchObject({
        unitPriceMinor: 1001,
        availableInventory: 1,
        isAvailable: false,
      });
    } finally {
      await db('products').where({ id: 'mug' }).update({
        unit_price_minor: before.unit_price_minor,
        inventory: before.inventory,
      });
    }
  });

  it('serializes competing writes and leaves one row per cart/product', async () => {
    const id = await newCart();
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        request(app)
          .put(`/carts/${id}/items/tea`)
          .send({ quantity: i + 1 }),
      ),
    );
    expect(responses.map((r) => r.status)).toEqual(Array(8).fill(200));
    const rows = await db('cart_items').where({ cart_id: id });
    expect(rows).toHaveLength(1);
    expect(rows[0].quantity).toBeGreaterThanOrEqual(1);
    expect(rows[0].quantity).toBeLessThanOrEqual(8);
    expect((await db('products').where({ id: 'tea' }).first()).inventory).toBe(
      30,
    );
  });

  it('rejects writes to completed carts and guards money conversion without partial writes', async () => {
    const id = await newCart();
    await db('carts').where({ id }).update({ status: 'CHECKED_OUT' });
    expect(
      (
        await request(app)
          .put(`/carts/${id}/items/coffee`)
          .send({ quantity: 1 })
          .expect(409)
      ).body.error.code,
    ).toBe('CART_ALREADY_CHECKED_OUT');
    await request(app).delete(`/carts/${id}/items/coffee`).expect(409);
    const openId = await newCart();
    const product = await db('products').where({ id: 'coffee' }).first();
    try {
      await db('products')
        .where({ id: 'coffee' })
        .update({ unit_price_minor: '9007199254740991' });
      expect(
        (
          await request(app)
            .put(`/carts/${openId}/items/coffee`)
            .send({ quantity: 2 })
            .expect(400)
        ).body.error.code,
      ).toBe('AMOUNT_OUT_OF_RANGE');
      expect(await db('cart_items').where({ cart_id: openId })).toEqual([]);
    } finally {
      await db('products')
        .where({ id: 'coffee' })
        .update({ unit_price_minor: product.unit_price_minor });
    }
  });
});
