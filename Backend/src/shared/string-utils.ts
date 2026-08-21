/** Escapes regex special characters so user-supplied search text can't be used to
 *  build unexpected/expensive regex patterns (or ReDoS-style repetition) when
 *  passed straight into a Mongo `$regex` filter. */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
