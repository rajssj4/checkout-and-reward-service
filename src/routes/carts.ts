import { Router } from 'express';
import { z } from 'zod';
import type { cartService } from '../services/carts.js';

const cartIdSchema = z.string().uuid();
const productIdSchema = z.string().min(1).max(128);
const quantitySchema = z
  .object({ quantity: z.number().int().min(1).max(1000000) })
  .strict();

export function cartRoutes(service: ReturnType<typeof cartService>) {
  const router = Router();
  router.get('/products', async (_req, res) => {
    res.json(await service.listProducts());
  });
  router.post('/carts', async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    const cart = await service.create();
    res.location(`/carts/${cart.id}`).status(201).json(cart);
  });
  router.get('/carts/:cartId', async (req, res) => {
    res.json(await service.get(cartIdSchema.parse(req.params.cartId)));
  });
  router.put('/carts/:cartId/items/:productId', async (req, res) => {
    const cartId = cartIdSchema.parse(req.params.cartId);
    const productId = productIdSchema.parse(req.params.productId);
    const { quantity } = quantitySchema.parse(req.body);
    res.json(await service.setItem(cartId, productId, quantity));
  });
  router.delete('/carts/:cartId/items/:productId', async (req, res) => {
    await service.removeItem(
      cartIdSchema.parse(req.params.cartId),
      productIdSchema.parse(req.params.productId),
    );
    res.status(204).end();
  });
  return router;
}
