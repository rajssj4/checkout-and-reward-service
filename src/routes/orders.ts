import { Router } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { checkoutService } from '../services/checkout.js';
import { getOrder } from '../services/orders.js';

const idSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
const keySchema = z.string().regex(/^[!-~]{1,128}$/);
const bodySchema = z
  .object({ couponCode: z.string().trim().min(1).max(128).optional() })
  .strict();

export function orderRoutes(db: Knex, currency: string) {
  const router = Router();
  const checkout = checkoutService(db, currency);
  router.post('/carts/:cartId/checkout', async (req, res) => {
    const cartId = idSchema.parse(req.params.cartId);
    const idempotencyKey = keySchema.parse(req.get('Idempotency-Key'));
    const { couponCode } = bodySchema.parse(req.body ?? {});
    const { order, replayed } = await checkout({
      cartId,
      idempotencyKey,
      couponCode,
    });
    res
      .location(`/orders/${order.id}`)
      .status(replayed ? 200 : 201)
      .json(order);
  });
  router.get('/orders/:orderId', async (req, res) => {
    res.json(await getOrder(db, idSchema.parse(req.params.orderId)));
  });
  return router;
}
