import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ChainBankError } from '../../../../src/domain/errors.js';
import { isUniqueViolation, withDatabaseErrors } from '../../../../src/infrastructure/db/client.js';

const SQL_TEXT = 'insert into "treasuries" ("address", "kind") values ($1, $2) /* tx28-sql */';
const BOUND_PARAMETER = '0xTX28_BOUND_PARAMETER';
const SQLSTATE = '23505';
const CONSTRAINT = 'treasuries_one_enabled_kind_per_chain';
const DETAIL = 'Key (chain_id, kind)=(19ec925a, external) already exists';

function driverError(): DrizzleQueryError {
  const postgres = Object.assign(
    new Error(`duplicate key value violates unique constraint "${CONSTRAINT}"`),
    {
      severity: 'ERROR',
      code: SQLSTATE,
      schema: 'public',
      table: 'treasuries',
      constraint: CONSTRAINT,
      detail: DETAIL,
    },
  );
  return new DrizzleQueryError(SQL_TEXT, [BOUND_PARAMETER, 'external'], postgres);
}

describe('withDatabaseErrors', () => {
  it('stores the postgres diagnostic in context.detail and leaves the query out', async () => {
    const thrown = driverError();

    const error = await withDatabaseErrors('treasuries.upsert', () => Promise.reject(thrown)).then(
      () => {
        throw new Error('expected the database operation to fail');
      },
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ChainBankError);
    if (!(error instanceof ChainBankError)) {
      return;
    }

    expect(error.code).toBe('DATABASE_UNAVAILABLE');
    expect(error.message).toBe('Database operation "treasuries.upsert" failed');
    expect(error.context.operation).toBe('treasuries.upsert');
    expect(isUniqueViolation(error)).toBe(true);

    const detail = error.context.detail;
    expect(typeof detail).toBe('string');
    if (typeof detail !== 'string') {
      return;
    }
    expect(detail).toContain(SQLSTATE);
    expect(detail).toContain(CONSTRAINT);
    expect(detail).toContain(DETAIL);
    expect(detail).not.toContain(SQL_TEXT);
    expect(detail).not.toContain(BOUND_PARAMETER);
    expect(detail).not.toContain('Failed query');
  });
});
