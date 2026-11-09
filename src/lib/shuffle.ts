import { getRandomValues } from 'expo-crypto';

const UINT32_RANGE = 0x1_0000_0000;
const buffer = new Uint32Array(1);

/**
 * Uniform random integer in [0, maxExclusive) from a cryptographically secure source.
 * Uses rejection sampling so there is no modulo bias.
 */
export function secureRandomInt(maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0 || maxExclusive > UINT32_RANGE) {
    throw new RangeError(`secureRandomInt: invalid bound ${maxExclusive}`);
  }
  const limit = UINT32_RANGE - (UINT32_RANGE % maxExclusive);
  for (;;) {
    getRandomValues(buffer);
    if (buffer[0] < limit) return buffer[0] % maxExclusive;
  }
}

/**
 * Picks up to `count` items uniformly at random without replacement (lazy Fisher–Yates),
 * skipping items whose `keyOf` was already picked. Does not mutate `items`.
 */
export function pickRandomUnique<T>(items: readonly T[], count: number, keyOf: (item: T) => string): T[] {
  const pool = items.slice();
  const seen = new Set<string>();
  const result: T[] = [];
  for (let i = 0; i < pool.length && result.length < count; i++) {
    const j = i + secureRandomInt(pool.length - i);
    [pool[i], pool[j]] = [pool[j], pool[i]];
    const key = keyOf(pool[i]);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(pool[i]);
  }
  return result;
}
