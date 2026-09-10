import { randomBytes, randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { DomainError } from '../domain/errors.js';
import { toMinorNumber } from '../domain/money.js';

interface CouponRow {
  id: string;
  code: string;
  milestone_number: string;
  discount_bps: number;
  created_at: Date;
  redeemed_order_id?: string | null;
}
function couponView(row: CouponRow) {
  return {
    id: row.id,
    code: row.code,
    milestoneNumber: toMinorNumber(BigInt(row.milestone_number)),
    discountBps: row.discount_bps,
    createdAt: row.created_at.toISOString(),
    status: row.redeemed_order_id ? 'REDEEMED' : 'AVAILABLE',
    redeemedOrderId: row.redeemed_order_id ?? null,
  };
}

export function couponService(db: Knex) {
  return {
    async generate() {
      return db.transaction(async (trx) => {
        await trx.raw("SET LOCAL lock_timeout = '2s'");
        // Serialize generators using the singleton settings row, across all instances.
        const settings = await trx('settings')
          .where({ id: 1 })
          .forUpdate()
          .first();
        const count = await trx('orders').count('* as count').first();
        const eligible =
          BigInt(String(count!.count)) / BigInt(settings.reward_every_n_orders);
        const last = await trx('coupons')
          .max('milestone_number as milestone')
          .first();
        // Coupons are append-only and milestones are allocated in sequence; no delete API exists.
        const next = BigInt(String(last?.milestone ?? 0)) + 1n;
        if (next > eligible)
          throw new DomainError(
            409,
            'NO_ELIGIBLE_MILESTONE',
            'No unrewarded order milestone is eligible.',
          );
        toMinorNumber(next);
        const [created] = await trx<CouponRow>('coupons')
          .insert({
            id: randomUUID(),
            code: randomBytes(24).toString('hex'),
            milestone_number: next.toString(),
            discount_bps: settings.discount_bps,
          })
          .returning('*');
        return couponView(created!);
      });
    },
    async list() {
      const rows = (await db('coupons as coupon')
        .leftJoin('orders as order', 'order.coupon_id', 'coupon.id')
        .select('coupon.*', 'order.id as redeemed_order_id')
        .orderBy('coupon.milestone_number')) as CouponRow[];
      return { coupons: rows.map(couponView) };
    },
  };
}
