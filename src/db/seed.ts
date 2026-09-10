import type { Knex } from 'knex';

export async function seed(db: Knex) {
  const products = [
    {
      id: 'coffee',
      name: 'Coffee beans',
      unit_price_minor: 1299,
      inventory: 20,
    },
    { id: 'tea', name: 'Green tea', unit_price_minor: 749, inventory: 30 },
    { id: 'mug', name: 'Ceramic mug', unit_price_minor: 999, inventory: 10 },
    { id: 'notebook', name: 'Notebook', unit_price_minor: 501, inventory: 15 },
    {
      id: 'limited-print',
      name: 'Limited edition print',
      unit_price_minor: 2500,
      inventory: 1,
    },
  ];
  await db.transaction(async (trx) => {
    await trx('products').insert(products).onConflict('id').ignore();
  });
}
