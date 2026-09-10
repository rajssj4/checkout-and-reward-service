import { DomainError } from './errors.js';

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
