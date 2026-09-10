import type { Knex } from 'knex';

export async function up(db: Knex) {
  await db.schema.createTable('coupons', (table) => {
    table.uuid('id').primary();
    table.string('code', 128).notNullable().unique();
    table.bigInteger('milestone_number').notNullable().unique();
    table.integer('discount_bps').notNullable();
    table
      .timestamp('created_at', { useTz: true })
      .notNullable()
      .defaultTo(db.fn.now());
    table.check('milestone_number BETWEEN 1 AND 9007199254740991');
    table.check('discount_bps BETWEEN 0 AND 10000');
  });
  await db.schema.alterTable('orders', (table) => {
    table
      .uuid('coupon_id')
      .nullable()
      .unique()
      .references('id')
      .inTable('coupons');
    table.string('coupon_code', 128).nullable();
    table.check(
      '(coupon_id IS NULL) = (coupon_code IS NULL)',
      [],
      'orders_coupon_snapshot_check',
    );
  });
}

export async function down(db: Knex) {
  await db.schema.alterTable('orders', (table) => {
    table.dropChecks('orders_coupon_snapshot_check');
    table.dropColumn('coupon_code');
    table.dropColumn('coupon_id');
  });
  await db.schema.dropTable('coupons');
}
