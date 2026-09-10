import { Router } from 'express';
import { z } from 'zod';
import type { Knex } from 'knex';
import { couponService } from '../services/coupons.js';
import { summaryReport } from '../services/reports.js';

// Administrative operations; authentication/authorization is intentionally outside assignment scope.
export function adminRoutes(db: Knex, currency: string) {
  const router = Router();
  const coupons = couponService(db);
  router.post('/admin/coupons', async (req, res) => {
    z.object({})
      .strict()
      .parse(req.body ?? {});
    res.status(201).json(await coupons.generate());
  });
  router.get('/admin/coupons', async (_req, res) => {
    res.json(await coupons.list());
  });
  router.get('/admin/reports/summary', async (_req, res) => {
    res.json(await summaryReport(db, currency));
  });
  return router;
}
