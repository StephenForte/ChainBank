import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { describeErrorChain } from '../../../src/domain/errors.js';

const RAW_MESSAGE = 'raw-message-do-not-render';
const SECRET_HASH = 'secret-hash';
const RPC_KEY = 'key-abc123';
const DRIVER_MESSAGE = 'duplicate key value violates unique constraint "leaky_message"';

function refusedConnect(address: string, port: number): Error {
  const error = new Error(`${RAW_MESSAGE} connect ECONNREFUSED ${address}:${port}`);
  return Object.assign(error, {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    address,
    port,
  });
}

describe('describeErrorChain AggregateError members', () => {
  it('renders ECONNREFUSED members from code, syscall, address, and port', () => {
    const rendered = describeErrorChain(
      new AggregateError([refusedConnect('::1', 1), refusedConnect('127.0.0.1', 1)]),
    );

    expect(rendered).toContain('ECONNREFUSED');
    expect(rendered).toContain('127.0.0.1:1');
    expect(rendered).toContain('::1:1');
    expect(rendered).not.toContain(RAW_MESSAGE);
  });

  it('renders a DrizzleQueryError member by name and omits bound parameters', () => {
    const query = new DrizzleQueryError('select secret', [SECRET_HASH], new Error('driver'));
    const rendered = describeErrorChain(new AggregateError([query]));

    expect(query.message).toContain(SECRET_HASH);
    expect(rendered).toContain('DrizzleQueryError');
    expect(rendered).not.toContain(SECRET_HASH);
  });

  it('renders a viem-shaped member without the RPC URL', () => {
    const rpc = new Error(`HTTP request failed. URL: https://rpc.example/${RPC_KEY}`);
    Object.assign(rpc, { name: 'HttpRequestError', shortMessage: 'HTTP request failed.' });

    const rendered = describeErrorChain(new AggregateError([rpc]));

    expect(rendered).toContain('HttpRequestError');
    expect(rendered).toContain('HTTP request failed.');
    expect(rendered).not.toContain(RPC_KEY);
    expect(rendered).not.toContain('https://');
  });

  it('renders a postgres driver member from diagnostic fields', () => {
    const driver = Object.assign(new Error(DRIVER_MESSAGE), {
      severity: 'ERROR',
      code: '23505',
      constraint: 'wallets_pkey',
    });
    const rendered = describeErrorChain(new AggregateError([driver]));

    expect(rendered).toContain('code=23505');
    expect(rendered).toContain('constraint=wallets_pkey');
    expect(rendered).not.toContain(DRIVER_MESSAGE);
    expect(rendered).not.toContain('postgres://');
  });

  it('bounds a long member list and states how many were omitted', () => {
    const members = Array.from({ length: 20 }, (_, index) => new Error(`member-${index}`));
    const rendered = describeErrorChain(new AggregateError(members));

    expect(rendered).toContain('member-0');
    expect(rendered).not.toContain('member-19');
    expect(rendered).toContain('15 omitted');
  });

  it('terminates when an AggregateError contains itself', () => {
    const error = new AggregateError([]);
    error.errors.push(error);

    const rendered = describeErrorChain(error);

    expect(rendered).toContain('AggregateError');
    expect(rendered.length).toBeLessThan(400);
    expect(rendered.split('AggregateError').length).toBeLessThan(6);
  });

  it('renders a plain Error with message boom exactly as before', () => {
    expect(describeErrorChain(new Error('boom'))).toBe('Error: boom');
  });
});
