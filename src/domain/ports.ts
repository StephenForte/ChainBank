/**
 * Ambient system dependencies, declared by the domain and supplied by the
 * composition root. Injecting them keeps time- and identifier-dependent
 * behavior deterministic under test.
 */

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}
