import { DomainError } from './errors.js';

export function discountMinor(gross: bigint, basisPoints: number): bigint {
  if (
    gross < 0n ||
    !Number.isInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10000
  ) {
    throw new RangeError('Invalid discount inputs.');
  }
  return (gross * BigInt(basisPoints) + 5000n) / 10000n;
}

// PostgreSQL BIGINT values stay strings until exact arithmetic is complete.
export function toMinorNumber(amount: bigint): number {
  if (amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError(
      400,
      'AMOUNT_OUT_OF_RANGE',
      'Amount exceeds supported integer bounds.',
    );
  }
  return Number(amount);
}
