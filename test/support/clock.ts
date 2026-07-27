import type { Clock } from '../../src/domain/ports.js';

/** A clock that returns a fixed instant until advanced. */
export function createFixedClock(initial = new Date('2026-07-26T12:00:00.000Z')): Clock & {
  advance(ms: number): void;
  set(next: Date): void;
} {
  let current = initial;
  return {
    now: () => current,
    advance: (ms) => {
      current = new Date(current.getTime() + ms);
    },
    set: (next) => {
      current = next;
    },
  };
}
