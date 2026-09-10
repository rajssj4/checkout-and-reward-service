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
