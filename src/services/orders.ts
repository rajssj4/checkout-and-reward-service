import type { Knex } from 'knex';
import { DomainError } from '../domain/errors.js';
import { toMinorNumber } from '../domain/money.js';

export async function getOrder(db: Knex, id: string) {
  // Orders and items are committed together and never mutated by the API.
  const order = await db('orders').where({ id }).first();
  if (!order) throw new DomainError(404, 'ORDER_NOT_FOUND', 'Order not found.');
  const items = await db('order_items')
    .where({ order_id: id })
    .orderBy('product_id');
  return {
    id: order.id as string,
    cartId: order.cart_id as string,
    createdAt: (order.created_at as Date).toISOString(),
    currency: order.currency as string,
    coupon: order.coupon_id
      ? { id: order.coupon_id as string, code: order.coupon_code as string }
      : null,
    discountBps: order.discount_bps as number,
    grossMinor: toMinorNumber(BigInt(order.gross_minor)),
    discountMinor: toMinorNumber(BigInt(order.discount_minor)),
    netMinor: toMinorNumber(BigInt(order.net_minor)),
    items: items.map((item) => ({
      productId: item.product_id as string,
      name: item.product_name as string,
      unitPriceMinor: toMinorNumber(BigInt(item.unit_price_minor)),
      quantity: item.quantity as number,
      lineTotalMinor: toMinorNumber(BigInt(item.line_total_minor)),
    })),
  };
}
