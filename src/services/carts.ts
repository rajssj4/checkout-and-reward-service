import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { DomainError } from '../domain/errors.js';
import { toMinorNumber } from '../domain/money.js';

interface CartRow {
  id: string;
  status: 'OPEN' | 'CHECKED_OUT';
  created_at: Date;
}
interface ProductRow {
  id: string;
  name: string;
  unit_price_minor: string;
  inventory: number;
}

async function cartView(db: Knex, id: string, currency: string) {
  const cart = await db<CartRow>('carts').where({ id }).first();
  if (!cart) throw new DomainError(404, 'CART_NOT_FOUND', 'Cart not found.');
  const rows = (await db('cart_items as item')
    .join('products as product', 'product.id', 'item.product_id')
    .where('item.cart_id', id)
    .select(
      'product.id',
      'product.name',
      'product.unit_price_minor',
      'product.inventory',
      'item.quantity',
    )
    .orderBy('product.id')) as (ProductRow & { quantity: number })[];
  let gross = 0n;
  const items = rows.map((row) => {
    const lineTotal = BigInt(row.unit_price_minor) * BigInt(row.quantity);
    gross += lineTotal;
    return {
      productId: row.id,
      name: row.name,
      quantity: row.quantity,
      unitPriceMinor: toMinorNumber(BigInt(row.unit_price_minor)),
      lineTotalMinor: toMinorNumber(lineTotal),
      availableInventory: row.inventory,
      isAvailable: row.inventory >= row.quantity,
    };
  });
  return {
    id: cart.id,
    status: cart.status,
    createdAt: cart.created_at.toISOString(),
    currency,
    items,
    grossMinor: toMinorNumber(gross),
  };
}

async function lockOpenCart(trx: Knex.Transaction, id: string) {
  await trx.raw("SET LOCAL lock_timeout = '2s'");
  const cart = await trx<CartRow>('carts').where({ id }).forUpdate().first();
  if (!cart) throw new DomainError(404, 'CART_NOT_FOUND', 'Cart not found.');
  if (cart.status !== 'OPEN')
    throw new DomainError(
      409,
      'CART_ALREADY_CHECKED_OUT',
      'Cart is already checked out.',
    );
}

export function cartService(db: Knex, currency: string) {
  return {
    async listProducts() {
      const rows = await db<ProductRow>('products').select('*').orderBy('id');
      return {
        products: rows.map((row) => ({
          id: row.id,
          name: row.name,
          unitPriceMinor: toMinorNumber(BigInt(row.unit_price_minor)),
          inventory: row.inventory,
          currency,
        })),
      };
    },
    async create() {
      return db.transaction(async (trx) => {
        const id = randomUUID();
        await trx('carts').insert({ id });
        return cartView(trx, id, currency);
      });
    },
    async get(id: string) {
      return db.transaction((trx) => cartView(trx, id, currency), {
        isolationLevel: 'repeatable read',
        readOnly: true,
      });
    },
    async setItem(id: string, productId: string, quantity: number) {
      return db.transaction(async (trx) => {
        await lockOpenCart(trx, id);
        // Hold the observed stock stable until this short cart mutation commits.
        const product = await trx<ProductRow>('products')
          .where({ id: productId })
          .forShare()
          .first();
        if (!product)
          throw new DomainError(404, 'PRODUCT_NOT_FOUND', 'Product not found.');
        if (product.inventory < quantity)
          throw new DomainError(
            409,
            'INSUFFICIENT_INVENTORY',
            'Requested quantity exceeds available inventory.',
            { productId, requested: quantity, available: product.inventory },
          );
        await trx('cart_items')
          .insert({ cart_id: id, product_id: productId, quantity })
          .onConflict(['cart_id', 'product_id'])
          .merge({ quantity });
        return cartView(trx, id, currency);
      });
    },
    async removeItem(id: string, productId: string) {
      await db.transaction(async (trx) => {
        await lockOpenCart(trx, id);
        await trx('cart_items')
          .where({ cart_id: id, product_id: productId })
          .delete();
      });
    },
  };
}
