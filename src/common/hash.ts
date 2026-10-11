/**
 * FNV-1a 32-bit hash. Deterministic and dependency-free, used to derive stable
 * pseudo-random values from strings (e.g. the mocked geocoding coordinates).
 */
export function fnv1aHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}
