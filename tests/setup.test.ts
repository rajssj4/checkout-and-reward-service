import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';

describe('service foundation', () => {
  it('serves health and consistent HTTP errors', async () => {
    const app = createApp();
    expect((await request(app).get('/health').expect(200)).body).toEqual({
      status: 'ok',
    });
    expect(
      (await request(app).get('/missing').expect(404)).body.error.code,
    ).toBe('ROUTE_NOT_FOUND');
    expect(
      (
        await request(app)
          .post('/health')
          .set('Content-Type', 'application/json')
          .send('{')
          .expect(400)
      ).body.error.code,
    ).toBe('INVALID_JSON');
  });

  it('rejects invalid configuration', () => {
    for (const env of [
      { PORT: '0' },
      { REWARD_EVERY_N_ORDERS: '0' },
      { DISCOUNT_BPS: '10001' },
      { CURRENCY: 'XYZ' },
    ]) {
      expect(() => readConfig(env)).toThrow();
    }
  });
});
