import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z
    .string()
    .url()
    .regex(/^postgres(?:ql)?:\/\//)
    .default('postgresql://checkout:checkout@localhost:5433/checkout'),
  REWARD_EVERY_N_ORDERS: z.coerce
    .number()
    .int()
    .positive()
    .max(2147483647)
    .default(5),
  DISCOUNT_BPS: z.coerce.number().int().min(0).max(10000).default(1000),
  CURRENCY: z.literal('USD').default('USD'),
});

export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  return schema.parse(env);
}

export type Config = ReturnType<typeof readConfig>;
