import type { Knex } from 'knex';
import { toMinorNumber } from '../domain/money.js';

export async function summaryReport(db: Knex, currency: string) {
  return db.transaction(
    async (trx) => {
      // Sum order amounts separately from items so multi-item orders cannot multiply revenue.
      const totals = await trx('orders')
        .select(
          trx.raw('COUNT(*) AS successful_orders'),
          trx.raw('COALESCE(SUM(gross_minor), 0) AS gross'),
          trx.raw('COALESCE(SUM(discount_minor), 0) AS discounts'),
          trx.raw('COALESCE(SUM(net_minor), 0) AS net'),
          trx.raw('COUNT(coupon_id) AS redeemed'),
        )
        .first();
      const generated = await trx('coupons').count('* as count').first();
      const quantities = await trx('products as product')
        .leftJoin('order_items as item', 'item.product_id', 'product.id')
        .select('product.id as product_id')
        .select(trx.raw('COALESCE(SUM(item.quantity), 0) AS quantity'))
        .groupBy('product.id')
        .orderBy('product.id');
      const generatedCount = BigInt(String(generated!.count));
      const redeemedCount = BigInt(totals.redeemed);
      return {
        currency,
        purchasedByProduct: quantities.map((row) => ({
          productId: row.product_id as string,
          quantity: toMinorNumber(BigInt(row.quantity)),
        })),
        grossRevenueMinor: toMinorNumber(BigInt(totals.gross)),
        totalDiscountsMinor: toMinorNumber(BigInt(totals.discounts)),
        netRevenueMinor: toMinorNumber(BigInt(totals.net)),
        coupons: {
          generated: toMinorNumber(generatedCount),
          available: toMinorNumber(generatedCount - redeemedCount),
          redeemed: toMinorNumber(redeemedCount),
        },
        successfulOrders: toMinorNumber(BigInt(totals.successful_orders)),
      };
    },
    { isolationLevel: 'repeatable read', readOnly: true },
  );
}
