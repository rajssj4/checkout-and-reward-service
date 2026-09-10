import type { Knex } from 'knex';

export async function up(db: Knex) {
  await db.schema.createTable('orders', (table) => {
    table.uuid('id').primary();
    table
      .uuid('cart_id')
      .notNullable()
      .unique()
      .references('id')
      .inTable('carts');
    table.string('idempotency_key', 128).notNullable().unique();
    table.text('request_fingerprint').notNullable();
    table.text('currency').notNullable();
    table.integer('discount_bps').notNullable();
    table.bigInteger('gross_minor').notNullable();
    table.bigInteger('discount_minor').notNullable();
    table.bigInteger('net_minor').notNullable();
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(db.fn.now());
    table.check("currency = 'USD'");
    table.check('discount_bps BETWEEN 0 AND 10000');
    table.check('gross_minor BETWEEN 0 AND 9007199254740991');
    table.check('discount_minor BETWEEN 0 AND gross_minor');
    table.check('net_minor = gross_minor - discount_minor');
  });
  await db.schema.createTable('order_items', (table) => {
    table.uuid('order_id').notNullable().references('id').inTable('orders');
    table.text('product_id').notNullable().references('id').inTable('products');
    table.text('product_name').notNullable();
    table.bigInteger('unit_price_minor').notNullable();
    table.integer('quantity').notNullable();
    table.bigInteger('line_total_minor').notNullable();
    table.primary(['order_id', 'product_id']);
    table.check('quantity BETWEEN 1 AND 1000000');
    table.check('unit_price_minor BETWEEN 0 AND 9007199254740991');
    table.check('line_total_minor BETWEEN 0 AND 9007199254740991');
    table.check('line_total_minor = unit_price_minor * quantity');
  });
}

export async function down(db: Knex) {
  await db.schema.dropTable('order_items');
  await db.schema.dropTable('orders');
}
