import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { ChainBankError, describeErrorChain, describeUnknownError } from '../../../src/domain/errors.js';

const SQL_TEXT = 'insert into "treasuries" ("address", "kind") values ($1, $2) /* tx28-sql */';
const BOUND_PARAMETER = '0xTX28_BOUND_PARAMETER';
const SQLSTATE = '23505';
const CONSTRAINT = 'treasuries_one_enabled_kind_per_chain';
const DETAIL = 'Key (chain_id, kind)=(19ec925a, external) already exists';

function postgresDriverError(): Error {
  const driver = new Error(`duplicate key value violates unique constraint "${CONSTRAINT}"`);
  return Object.assign(driver, {
    severity: 'ERROR',
    code: SQLSTATE,
    schema: 'public',
    table: 'treasuries',
    constraint: CONSTRAINT,
    detail: DETAIL,
  });
}

function incidentError(): ChainBankError {
  const driver = new DrizzleQueryError(SQL_TEXT, [BOUND_PARAMETER, 'external'], postgresDriverError());
  return new ChainBankError('DATABASE_UNAVAILABLE', 'Database operation "treasuries.upsert" failed', {
    cause: driver,
  });
}

function expectPostgresDiagnostic(rendered: string): void {
  expect(rendered).toContain(SQLSTATE);
  expect(rendered).toContain(CONSTRAINT);
  expect(rendered).toContain(DETAIL);
  expect(rendered).toContain('treasuries');
  expect(rendered).not.toContain(SQL_TEXT);
  expect(rendered).not.toContain(BOUND_PARAMETER);
  expect(rendered).not.toContain('Failed query');
}

describe('describeErrorChain', () => {
  it('renders a ChainBankError, the drizzle wrapper name, and the postgres diagnostic', () => {
    const rendered = describeErrorChain(incidentError());

    expect(rendered).toContain('ChainBankError');
    expect(rendered).toContain('DATABASE_UNAVAILABLE');
    expect(rendered).toContain('DrizzleQueryError');
    expectPostgresDiagnostic(rendered);
  });

  it('renders a postgres-shaped plain object without requiring an Error instance', () => {
    const rendered = describeErrorChain({
      code: SQLSTATE,
      severity: 'ERROR',
      constraint: CONSTRAINT,
      detail: DETAIL,
      table: 'treasuries',
    });

    expectPostgresDiagnostic(rendered);
    expect(rendered).not.toContain('duplicate key');
  });

  it('omits absent postgres fields', () => {
    const rendered = describeErrorChain({
      code: SQLSTATE,
      severity: 'ERROR',
      constraint: CONSTRAINT,
    });

    expect(rendered).toContain(SQLSTATE);
    expect(rendered).toContain(CONSTRAINT);
    expect(rendered).not.toContain('detail=');
    expect(rendered).not.toContain('hint=');
    expect(rendered).not.toContain('schema=');
    expect(rendered).not.toContain('table=');
  });

  it('terminates when a cause points at itself', () => {
    const error = new Error('self-cause');
    error.cause = error;

    const rendered = describeErrorChain(error);

    expect(rendered).toContain('self-cause');
    expect(rendered.split('self-cause')).toHaveLength(2);
  });

  it('renders at most five levels of a cause chain', () => {
    let current: Error = new Error('level-6');
    for (let level = 5; level >= 1; level -= 1) {
      current = new Error(`level-${level}`, { cause: current });
    }

    const rendered = describeErrorChain(current);

    expect(rendered).toContain('level-1');
    expect(rendered).toContain('level-5');
    expect(rendered).not.toContain('level-6');
  });

  it('renders a plain Error and a non-Error thrown value', () => {
    expect(describeErrorChain(new Error('plain failure'))).toContain('Error');
    expect(describeErrorChain(new Error('plain failure'))).toContain('plain failure');
    expect(describeErrorChain('disk full')).toContain('disk full');
    expect(describeErrorChain(42)).toContain('Non-error value thrown');
    expect(describeErrorChain(undefined)).toContain('Non-error value thrown');
  });

  it('does not follow a cause into describeUnknownError', () => {
    const summary = describeUnknownError(incidentError());

    expect(summary).toBe('ChainBankError: Database operation "treasuries.upsert" failed');
    expect(summary).not.toContain(SQLSTATE);
    expect(summary).not.toContain(CONSTRAINT);
    expect(summary).not.toContain(BOUND_PARAMETER);
  });
});
