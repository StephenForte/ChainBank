import { describe, expect, it } from 'vitest';
import { integrationEnabled } from '../support/integration-setup.js';

/**
 * Placeholder until Phase 0 repository and shared-Postgres stories get full
 * integration coverage. Kept so the Vitest project wiring is exercised.
 */
describe.skipIf(!integrationEnabled)('integration suite wiring', () => {
  it('has DATABASE_URL when opted in', () => {
    expect(process.env.DATABASE_URL?.length).toBeGreaterThan(0);
  });
});
