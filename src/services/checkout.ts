import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { DomainError } from '../domain/errors.js';
import { discountMinor, toMinorNumber } from '../domain/money.js';
import { getOrder } from './orders.js';

export interface CheckoutInput {
  cartId: string;
  idempotencyKey: string;
  couponCode?: string;
}

export function checkoutService(db: Knex, currency: string) {
  return async ({ cartId, idempotencyKey, couponCode }: CheckoutInput) => {
    const fingerprint = JSON.stringify({
      cartId,
      couponCode: couponCode ?? null,
    });
    return db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '2s'");
      // Serialize this key across application instances before reading its result.
      // Hash collisions only serialize unrelated keys; unique constraints remain authoritative.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
        idempotencyKey,
      ]);
      const existing = await trx('orders')
        .where({ idempotency_key: idempotencyKey })
        .first();
      if (existing) {
        if (existing.request_fingerprint !== fingerprint) {
          throw new DomainError(
            409,
            'IDEMPOTENCY_KEY_REUSED',
            'Idempotency key was used with different checkout inputs.',
          );
        }
        return { replayed: true, order: await getOrder(trx, existing.id) };
      }
      const cart = await trx('carts').where({ id: cartId }).forUpdate().first();
      if (!cart)
        throw new DomainError(404, 'CART_NOT_FOUND', 'Cart not found.');
      if (cart.status !== 'OPEN') {
        const order = await trx('orders')
          .where({ cart_id: cartId })
          .first('id');
        throw new DomainError(
          409,
          'CART_ALREADY_CHECKED_OUT',
          'Cart is already checked out.',
          order ? { orderId: order.id } : undefined,
        );
      }
      const items = await trx('cart_items')
        .where({ cart_id: cartId })
        .orderBy('product_id');
      if (items.length === 0)
        throw new DomainError(
          409,
          'EMPTY_CART',
          'Cannot check out an empty cart.',
        );
      let coupon:
        { id: string; code: string; discount_bps: number } | undefined;
      if (couponCode) {
        coupon = await trx('coupons')
          .where({ code: couponCode })
          .forUpdate()
          .first();
        if (!coupon)
          throw new DomainError(409, 'COUPON_INVALID', 'Coupon is not valid.');
        if (await trx('orders').where({ coupon_id: coupon.id }).first('id')) {
          throw new DomainError(
            409,
            'COUPON_ALREADY_REDEEMED',
            'Coupon has already been redeemed.',
          );
        }
      }

      const snapshots = [];
      let gross = 0n;
      // All writers acquire the cart first, then product locks in product-ID order.
      for (const item of items) {
        const product = await trx('products')
          .where({ id: item.product_id })
          .forUpdate()
          .first();
        if (!product)
          throw new DomainError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        if (
          !Number.isInteger(item.quantity) ||
          item.quantity < 1 ||
          item.quantity > 1000000
        ) {
          throw new DomainError(
            400,
            'VALIDATION_ERROR',
            'Invalid cart quantity.',
          );
        }
        if (product.inventory < item.quantity) {
          throw new DomainError(
            409,
            'INSUFFICIENT_INVENTORY',
            'Requested quantity exceeds available inventory.',
            {
              productId: product.id,
              requested: item.quantity,
              available: product.inventory,
            },
          );
        }
        const unitPrice = BigInt(product.unit_price_minor);
        toMinorNumber(unitPrice);
        const lineTotal = unitPrice * BigInt(item.quantity);
        toMinorNumber(lineTotal);
        gross += lineTotal;
        snapshots.push({
          product_id: product.id,
          product_name: product.name,
          unit_price_minor: unitPrice.toString(),
          quantity: item.quantity,
          line_total_minor: lineTotal.toString(),
        });
      }
      toMinorNumber(gross);
      const discountBps = coupon?.discount_bps ?? 0;
      const discount = discountMinor(gross, discountBps);
      for (const item of snapshots) {
        const affected = await trx('products')
          .where({ id: item.product_id })
          .where('inventory', '>=', item.quantity)
          .decrement('inventory', item.quantity);
        if (affected !== 1)
          throw new DomainError(
            409,
            'INSUFFICIENT_INVENTORY',
            'Inventory changed during checkout.',
          );
      }
      const id = randomUUID();
      await trx('orders').insert({
        id,
        cart_id: cartId,
        idempotency_key: idempotencyKey,
        request_fingerprint: fingerprint,
        currency,
        coupon_id: coupon?.id ?? null,
        coupon_code: coupon?.code ?? null,
        discount_bps: discountBps,
        gross_minor: gross.toString(),
        discount_minor: discount.toString(),
        net_minor: (gross - discount).toString(),
      });
      await trx('order_items').insert(
        snapshots.map((item) => ({ ...item, order_id: id })),
      );
      await trx('carts')
        .where({ id: cartId })
        .update({ status: 'CHECKED_OUT' });
      return { replayed: false, order: await getOrder(trx, id) };
    }); // The caller receives a result only after COMMIT succeeds.
  };
}
