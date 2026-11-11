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

/** Uniform random number in [0, 1) from a cryptographically secure source (32 bits of randomness). */
function secureRandomFraction(): number {
  return secureRandomInt(UINT32_RANGE) / UINT32_RANGE;
}

/**
 * Picks up to `count` items in two steps: first a group, chosen with probability proportional to its
 * `weight`, then an item of that group uniformly at random (without replacement). A group that runs
 * out of items leaves the draw. Items whose `keyOf` was already picked are skipped, so an item that is
 * in several groups (e.g. a song on a release shared by two artists) is picked at most once.
 * Does not mutate `groups`.
 */
export function pickRandomFromGroups<T>(
  groups: readonly { weight: number; items: readonly T[] }[],
  count: number,
  keyOf: (item: T) => string,
): T[] {
  const pools = groups
    .filter((g) => g.weight > 0 && g.items.length > 0)
    .map((g) => ({
      weight: g.weight,
      items: g.items.slice(),
    }));
  let totalWeight = pools.reduce((sum, p) => sum + p.weight, 0);
  const seen = new Set<string>();
  const result: T[] = [];

  while (result.length < count && pools.length > 0) {
    // Step 1: a group, weighted.
    let r = secureRandomFraction() * totalWeight;
    let g = 0;
    while (g < pools.length - 1 && r >= pools[g].weight) {
      r -= pools[g].weight;
      g++;
    }
    const pool = pools[g];

    // Step 2: an item of that group, uniformly; swap-remove it so it cannot come up again.
    const i = secureRandomInt(pool.items.length);
    const item = pool.items[i];
    pool.items[i] = pool.items[pool.items.length - 1];
    pool.items.pop();
    if (pool.items.length === 0) {
      totalWeight -= pool.weight;
      pools.splice(g, 1);
    }

    const key = keyOf(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}
