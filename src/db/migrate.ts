import type { Knex } from 'knex';
import type { Config } from '../config.js';
import * as foundation from './migrations/001-foundation.js';
import * as carts from './migrations/002-carts.js';

export async function assertSettings(db: Knex, config: Config) {
  const settings = await db('settings').where({ id: 1 }).first();
  if (!settings)
    throw new Error('Database is not initialized. Run npm run db:migrate.');
  if (
    settings.reward_every_n_orders !== config.REWARD_EVERY_N_ORDERS ||
    settings.discount_bps !== config.DISCOUNT_BPS ||
    settings.currency !== config.CURRENCY
  )
    throw new Error(
      'Configuration differs from persisted database reward/currency settings.',
    );
}

export async function migrate(db: Knex, config: Config) {
  const migrations: Record<string, Knex.Migration> = {
    '001-foundation': foundation,
    '002-carts': carts,
  };
  // Explicit source works in both TypeScript development and compiled JavaScript.
  await db.migrate.latest({
    migrationSource: {
      getMigrations: async () => Object.keys(migrations),
      getMigrationName: (name: string) => name,
      getMigration: async (name: string) => {
        const migration = migrations[name];
        if (!migration) throw new Error(`Unknown migration: ${name}`);
        return migration;
      },
    },
  });
  await db.transaction(async (trx) => {
    await trx('settings')
      .insert({
        id: 1,
        reward_every_n_orders: config.REWARD_EVERY_N_ORDERS,
        discount_bps: config.DISCOUNT_BPS,
        currency: config.CURRENCY,
      })
      .onConflict('id')
      .ignore();
    await assertSettings(trx, config);
  });
}
