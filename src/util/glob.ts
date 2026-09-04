/**
 * Tiny glob matcher for entity/field allow, deny and redaction lists.
 * Supports `*` (any run of characters) and `?` (one character). Case-insensitive.
 * Deliberately not a dependency: the whole feature is two lines of regex.
 */

const cache = new Map<string, RegExp>();

export function globToRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  const rx = new RegExp(`^${escaped}$`, "i");
  cache.set(pattern, rx);
  return rx;
}

export function globMatch(pattern: string, value: string): boolean {
  if (!pattern.includes("*") && !pattern.includes("?")) return pattern.toLowerCase() === value.toLowerCase();
  return globToRegExp(pattern).test(value);
}

export function matchesAny(patterns: readonly string[] | undefined, value: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => globMatch(p, value));
}
