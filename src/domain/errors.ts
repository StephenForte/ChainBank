/**
 * Error taxonomy shared by every layer.
 *
 * A category determines the transport status and whether a caller may retry.
 * A code is a stable machine-readable contract; never reword one without a
 * migration note, because operators and CI callers branch on it.
 */
export type ErrorCategory =
  | 'validation'
  | 'authentication'
  | 'authorization'
  | 'not_found'
  | 'conflict'
  | 'dependency_unavailable'
  | 'provider_retriable'
  | 'internal';

export type ErrorCode =
  // validation
  | 'INVALID_REQUEST'
  | 'INVALID_CONFIGURATION'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  // authentication and authorization
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_CREDENTIAL'
  | 'CREDENTIAL_DISABLED'
  | 'INSUFFICIENT_ROLE'
  | 'FUNDING_DISABLED'
  // resources
  | 'TREASURY_NOT_FOUND'
  | 'CHAIN_NOT_FOUND'
  // dependencies
  | 'DATABASE_UNAVAILABLE'
  | 'RPC_UNAVAILABLE'
  | 'CHAIN_ID_MISMATCH'
  | 'SIGNER_CHAIN_MISMATCH'
  | 'SIGNER_UNAVAILABLE'
  | 'GAS_ESTIMATION_FAILED'
  | 'EMAIL_PROVIDER_UNAVAILABLE'
  | 'EMAIL_PROVIDER_REJECTED'
  // catch-all
  | 'INTERNAL_ERROR';

const CATEGORY_BY_CODE: Readonly<Record<ErrorCode, ErrorCategory>> = {
  INVALID_REQUEST: 'validation',
  INVALID_CONFIGURATION: 'validation',
  INVALID_ADDRESS: 'validation',
  INVALID_AMOUNT: 'validation',
  AUTHENTICATION_REQUIRED: 'authentication',
  INVALID_CREDENTIAL: 'authentication',
  CREDENTIAL_DISABLED: 'authentication',
  INSUFFICIENT_ROLE: 'authorization',
  FUNDING_DISABLED: 'authorization',
  TREASURY_NOT_FOUND: 'not_found',
  CHAIN_NOT_FOUND: 'not_found',
  DATABASE_UNAVAILABLE: 'dependency_unavailable',
  RPC_UNAVAILABLE: 'dependency_unavailable',
  CHAIN_ID_MISMATCH: 'dependency_unavailable',
  SIGNER_CHAIN_MISMATCH: 'dependency_unavailable',
  SIGNER_UNAVAILABLE: 'dependency_unavailable',
  GAS_ESTIMATION_FAILED: 'dependency_unavailable',
  EMAIL_PROVIDER_UNAVAILABLE: 'dependency_unavailable',
  EMAIL_PROVIDER_REJECTED: 'provider_retriable',
  INTERNAL_ERROR: 'internal',
};

const HTTP_STATUS_BY_CATEGORY: Readonly<Record<ErrorCategory, number>> = {
  validation: 400,
  authentication: 401,
  authorization: 403,
  not_found: 404,
  conflict: 409,
  dependency_unavailable: 503,
  provider_retriable: 502,
  internal: 500,
};

export interface ChainBankErrorOptions {
  /** Message safe to return to a client. Must never embed secrets or provider detail. */
  readonly publicMessage?: string;
  /** Structured diagnostic context for logs only. */
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class ChainBankError extends Error {
  readonly code: ErrorCode;
  readonly category: ErrorCategory;
  readonly httpStatus: number;
  readonly publicMessage: string;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(code: ErrorCode, internalMessage: string, options: ChainBankErrorOptions = {}) {
    super(internalMessage, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ChainBankError';
    this.code = code;
    this.category = CATEGORY_BY_CODE[code];
    this.httpStatus = HTTP_STATUS_BY_CATEGORY[this.category];
    this.publicMessage = options.publicMessage ?? DEFAULT_PUBLIC_MESSAGE[this.category];
    this.context = options.context ?? {};
  }
}

const DEFAULT_PUBLIC_MESSAGE: Readonly<Record<ErrorCategory, string>> = {
  validation: 'The request was not valid.',
  authentication: 'Authentication is required.',
  authorization: 'This credential is not permitted to perform that action.',
  not_found: 'The requested resource does not exist.',
  conflict: 'The request conflicts with the current state of the resource.',
  dependency_unavailable: 'A required dependency is currently unavailable.',
  provider_retriable: 'An upstream provider failed. The request may be retried.',
  internal: 'An unexpected internal error occurred.',
};

export function isChainBankError(error: unknown): error is ChainBankError {
  return error instanceof ChainBankError;
}

/**
 * Narrows an unknown thrown value to a loggable summary without ever assuming
 * it is an Error or that its message is safe to return to a client.
 */
export function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Non-error value thrown';
}
