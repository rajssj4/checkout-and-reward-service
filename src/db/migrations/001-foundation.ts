import type { Knex } from 'knex';

export async function up(db: Knex) {
  await db.schema.createTable('settings', (table) => {
    table.integer('id').primary();
    table.integer('reward_every_n_orders').notNullable();
    table.integer('discount_bps').notNullable();
    table.text('currency').notNullable();
    table.check('id = 1');
    table.check('reward_every_n_orders > 0');
    table.check('discount_bps BETWEEN 0 AND 10000');
    table.check("currency = 'USD'");
  });
  await db.schema.createTable('products', (table) => {
    table.text('id').primary();
    table.text('name').notNullable();
    table.bigInteger('unit_price_minor').notNullable();
    table.integer('inventory').notNullable();
    table.check('unit_price_minor >= 0');
    table.check('inventory >= 0');
  });
}

export async function down(db: Knex) {
  await db.schema.dropTable('products');
  await db.schema.dropTable('settings');
}
