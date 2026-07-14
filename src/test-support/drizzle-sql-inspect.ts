/**
 * Circular-safe walker over Drizzle's `sql` template `queryChunks` field.
 * Returns a flattened JSON string usable in test substring assertions
 * (indexOf / regex) without wrestling with the circular PgTable graph that
 * lives inside column references.
 *
 * Extracted from gmail-sender.spec.ts (Task 4b) to avoid duplicating the
 * WeakSet boilerplate at every callsite that needs to peek at a Drizzle
 * `sql` value passed into a mock `.update().set(...)` call.
 */
export function stringifySqlChunks(patch: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(patch, (_key, value) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]';
      seen.add(value);
    }
    return value;
  });
}
