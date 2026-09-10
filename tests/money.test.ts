import { describe, expect, it } from 'vitest';
import { discountMinor } from '../src/domain/money.js';

describe('order-level discount rounding', () => {
  it.each([
    [0n, 1000, 0n],
    [5n, 1000, 1n],
    [4n, 1000, 0n],
    [501n, 5000, 251n],
    [1800n, 5000, 900n],
    [999n, 0, 0n],
    [999n, 10000, 999n],
    [9007199254740991n, 5000, 4503599627370496n],
  ])('discounts %s at %i basis points to %s', (gross, rate, expected) => {
    expect(discountMinor(gross, rate)).toBe(expected);
  });
  it('rejects invalid discount inputs', () => {
    expect(() => discountMinor(-1n, 1000)).toThrow();
    for (const rate of [-1, 10001, 0.5, NaN])
      expect(() => discountMinor(100n, rate)).toThrow();
  });
});
