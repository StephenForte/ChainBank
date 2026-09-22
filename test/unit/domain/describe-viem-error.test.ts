import { HttpRequestError, LimitExceededRpcError, RpcRequestError } from 'viem';
import { describe, expect, it } from 'vitest';
import { ChainBankError, describeErrorChain, describeUnknownError } from '../../../src/domain/errors.js';

/** Recognisable path segment placed in the fixture URL. Not a deployed credential. */
const PATH_SEGMENT = '0123456789abcdef0123456789abcdef01234567';
const HOST = 'chaotic-young-grass.base-sepolia.quiknode.pro';
const BODY_MARKER = 'tx30-signed-raw-body-marker';
const DETAILS = 'account limited to 50/sec';
const RPC_URL = `https://${HOST}/${PATH_SEGMENT}/`;
const SCAN_MESSAGE = 'Treasury outgoing transaction scan could not be completed.';

function rpcRequestError(): RpcRequestError {
  return new RpcRequestError({
    url: RPC_URL,
    body: {
      method: 'eth_getBlockByNumber',
      params: ['0x2cf519a', true],
      signed: BODY_MARKER,
    },
    error: { code: -32005, message: DETAILS },
  });
}

function httpRequestError(): HttpRequestError {
  return new HttpRequestError({
    url: RPC_URL,
    body: {
      method: 'eth_sendRawTransaction',
      params: [BODY_MARKER],
    },
    status: 429,
    details: DETAILS,
  });
}

function expectOperatorSummary(rendered: string, errorName: string, shortMessage: string): void {
  expect(rendered).toContain(errorName);
  expect(rendered).toContain(shortMessage);
  expect(rendered).toContain(DETAILS);
  expect(rendered).not.toContain(PATH_SEGMENT);
  expect(rendered).not.toContain(HOST);
  expect(rendered).not.toContain(BODY_MARKER);
  expect(rendered).not.toContain('https://');
  expect(rendered).not.toContain('Request body');
}

describe('viem error rendering', () => {
  it('renders an RpcRequestError from shortMessage and details, never the URL or body', () => {
    const rendered = describeUnknownError(rpcRequestError());

    expectOperatorSummary(rendered, 'RpcRequestError', 'RPC Request failed.');
    expect(rendered).toContain('code=-32005');
    expect(rendered).not.toContain('viem@');
  });

  it('renders an HttpRequestError from shortMessage, details, and status', () => {
    const rendered = describeUnknownError(httpRequestError());

    expectOperatorSummary(rendered, 'HttpRequestError', 'HTTP request failed.');
    expect(rendered).toContain('status=429');
    expect(rendered).not.toContain('viem@');
  });

  it('renders a viem cause under a ChainBankError without the URL or body', () => {
    const wrapped = new ChainBankError('RPC_UNAVAILABLE', SCAN_MESSAGE, {
      cause: rpcRequestError(),
    });

    expect(describeUnknownError(wrapped)).toBe(`ChainBankError: ${SCAN_MESSAGE}`);

    const rendered = describeErrorChain(wrapped);
    expect(rendered.startsWith(`ChainBankError RPC_UNAVAILABLE: ${SCAN_MESSAGE} <- `)).toBe(true);
    expectOperatorSummary(rendered, 'RpcRequestError', 'RPC Request failed.');
    expect(rendered).toContain('code=-32005');
  });

  it('renders LimitExceededRpcError and its RpcRequestError cause without the URL or body', () => {
    const nested = new LimitExceededRpcError(rpcRequestError());
    const wrapped = new ChainBankError('RPC_UNAVAILABLE', SCAN_MESSAGE, { cause: nested });

    expectOperatorSummary(
      describeUnknownError(nested),
      'LimitExceededRpcError',
      'Request exceeds defined limit.',
    );

    const rendered = describeErrorChain(wrapped);
    expect(rendered.startsWith(`ChainBankError RPC_UNAVAILABLE: ${SCAN_MESSAGE} <- `)).toBe(true);
    expectOperatorSummary(rendered, 'LimitExceededRpcError', 'Request exceeds defined limit.');
    expectOperatorSummary(rendered, 'RpcRequestError', 'RPC Request failed.');
    expect(rendered).toContain('code=-32005');
  });

  it('leaves ChainBankError and plain Error summaries unchanged', () => {
    const internal = 'Database operation "treasuries.upsert" failed';
    expect(describeUnknownError(new ChainBankError('DATABASE_UNAVAILABLE', internal))).toBe(
      `ChainBankError: ${internal}`,
    );
    expect(describeUnknownError(new Error(`plain failure ${PATH_SEGMENT}`))).toBe(
      `Error: plain failure ${PATH_SEGMENT}`,
    );
  });
});
