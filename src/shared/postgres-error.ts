/** True when the error (or a nested cause) is a Postgres unique-violation (23505). */
export function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === 'object' && 'code' in current && Reflect.get(current, 'code') === '23505') {
      return true;
    }
    if (current instanceof Error && current.cause !== undefined) {
      current = current.cause;
      continue;
    }
    break;
  }
  return false;
}
