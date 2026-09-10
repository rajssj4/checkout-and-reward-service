import type { Knex } from 'knex';

export async function up(db: Knex) {
  await db.schema.createTable('carts', (table) => {
    table.uuid('id').primary();
    table.text('status').notNullable().defaultTo('OPEN');
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(db.fn.now());
    table.check("status IN ('OPEN', 'CHECKED_OUT')");
  });
  await db.schema.createTable('cart_items', (table) => {
    table
      .uuid('cart_id')
      .notNullable()
      .references('id')
      .inTable('carts')
      .onDelete('CASCADE');
    table.text('product_id').notNullable().references('id').inTable('products');
    table.integer('quantity').notNullable();
    table.primary(['cart_id', 'product_id']);
    table.check('quantity BETWEEN 1 AND 1000000');
  });
}

export async function down(db: Knex) {
  await db.schema.dropTable('cart_items');
  await db.schema.dropTable('carts');
}
