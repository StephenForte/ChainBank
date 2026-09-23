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
  | 'CREDENTIAL_NOT_FOUND'
  | 'CREDENTIAL_SELF_MUTATION_DENIED'
  | 'CREDENTIAL_REVOKED'
  | 'USER_NOT_FOUND'
  | 'USER_EMAIL_CONFLICT'
  | 'INSUFFICIENT_ROLE'
  | 'FUNDING_DISABLED'
  | 'ENTITY_DISABLED'
  // resources
  | 'TREASURY_NOT_FOUND'
  | 'CHAIN_NOT_FOUND'
  | 'PROJECT_NOT_FOUND'
  | 'ENVIRONMENT_NOT_FOUND'
  | 'WALLET_NOT_FOUND'
  | 'WALLET_ALREADY_REGISTERED'
  | 'PROJECT_SLUG_CONFLICT'
  | 'ENVIRONMENT_SLUG_CONFLICT'
  | 'SCOPE_ALREADY_ASSIGNED'
  | 'SCOPE_DENIED'
  | 'FUNDING_OPERATION_NOT_FOUND'
  | 'FUNDING_TRANSACTION_NOT_FOUND'
  | 'ALERT_NOT_FOUND'
  // conflicts
  | 'PENDING_FUNDING_EXISTS'
  | 'FUNDING_BLOCKED_RESERVE'
  | 'INVALID_STATUS_TRANSITION'
  // transaction outcomes (row error_code and caller-facing where needed)
  | 'TRANSACTION_REVERTED'
  | 'TRANSACTION_REPLACED'
  | 'TRANSACTION_DROPPED'
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
  | 'INTERNAL_ERROR'
  // A reconciliation run was started and the process exited before finish.
  // Stamped onto the existing row; the row is not deleted (AGENTS.md §9).
  | 'RUN_ABORTED';

const CATEGORY_BY_CODE: Readonly<Record<ErrorCode, ErrorCategory>> = {
  INVALID_REQUEST: 'validation',
  INVALID_CONFIGURATION: 'validation',
  INVALID_ADDRESS: 'validation',
  INVALID_AMOUNT: 'validation',
  AUTHENTICATION_REQUIRED: 'authentication',
  INVALID_CREDENTIAL: 'authentication',
  CREDENTIAL_DISABLED: 'authentication',
  CREDENTIAL_NOT_FOUND: 'not_found',
  CREDENTIAL_SELF_MUTATION_DENIED: 'validation',
  CREDENTIAL_REVOKED: 'conflict',
  USER_NOT_FOUND: 'not_found',
  USER_EMAIL_CONFLICT: 'conflict',
  INSUFFICIENT_ROLE: 'authorization',
  FUNDING_DISABLED: 'authorization',
  ENTITY_DISABLED: 'authorization',
  TREASURY_NOT_FOUND: 'not_found',
  CHAIN_NOT_FOUND: 'not_found',
  PROJECT_NOT_FOUND: 'not_found',
  ENVIRONMENT_NOT_FOUND: 'not_found',
  WALLET_NOT_FOUND: 'not_found',
  WALLET_ALREADY_REGISTERED: 'conflict',
  PROJECT_SLUG_CONFLICT: 'conflict',
  ENVIRONMENT_SLUG_CONFLICT: 'conflict',
  SCOPE_ALREADY_ASSIGNED: 'conflict',
  SCOPE_DENIED: 'authorization',
  FUNDING_OPERATION_NOT_FOUND: 'not_found',
  FUNDING_TRANSACTION_NOT_FOUND: 'not_found',
  ALERT_NOT_FOUND: 'not_found',
  PENDING_FUNDING_EXISTS: 'conflict',
  FUNDING_BLOCKED_RESERVE: 'conflict',
  INVALID_STATUS_TRANSITION: 'conflict',
  TRANSACTION_REVERTED: 'conflict',
  TRANSACTION_REPLACED: 'conflict',
  TRANSACTION_DROPPED: 'conflict',
  DATABASE_UNAVAILABLE: 'dependency_unavailable',
  RPC_UNAVAILABLE: 'dependency_unavailable',
  CHAIN_ID_MISMATCH: 'dependency_unavailable',
  SIGNER_CHAIN_MISMATCH: 'dependency_unavailable',
  SIGNER_UNAVAILABLE: 'dependency_unavailable',
  GAS_ESTIMATION_FAILED: 'dependency_unavailable',
  EMAIL_PROVIDER_UNAVAILABLE: 'dependency_unavailable',
  EMAIL_PROVIDER_REJECTED: 'provider_retriable',
  INTERNAL_ERROR: 'internal',
  RUN_ABORTED: 'internal',
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
 *
 * A viem BaseError is duck-typed (string `shortMessage` on an Error) so this
 * module does not import viem. Its `message` concatenates `metaMessages`, which
 * for request errors include the endpoint URL and the JSON-RPC body. Those are
 * omitted here; see {@link renderViemBaseError}.
 */
export function describeUnknownError(error: unknown): string {
  if (isViemBaseError(error)) {
    return renderViemBaseError(error);
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  if (typeof error === 'string') {
    return error;
  }
  return 'Non-error value thrown';
}

/**
 * How many causes to render. Deep enough for ChainBankError → DrizzleQueryError
 * → the driver error, and shallow enough that a cyclic chain cannot hang startup.
 */
const MAX_ERROR_CHAIN_DEPTH = 5;

const ERROR_CHAIN_SEPARATOR = ' <- ';

const POSTGRES_DIAGNOSTIC_FIELDS = ['constraint', 'table', 'schema', 'detail', 'hint'] as const;

/**
 * Renders an error and its cause chain as one string for logs.
 *
 * Postgres driver errors are duck-typed so this module does not import `pg`.
 * node-postgres puts the SQLSTATE on `code` and a severity token (`ERROR`,
 * `FATAL`, …) on `severity`. A ChainBankError also has a string `code`, but
 * never a `severity`, so those two strings are what make a driver error
 * recognizable here. Rendered fields are `code`, `constraint`, `table`,
 * `schema`, `detail`, and `hint`; the driver message is left out.
 *
 * drizzle-orm wraps that driver error in `DrizzleQueryError`, whose message
 * embeds the SQL text and the bound parameters. Only the name is rendered.
 * drizzle-orm 0.45 calls `super()` and never assigns `this.name`, so the
 * instance's own `name` stays `"Error"`. The class name is `constructor.name`.
 * Either spelling is treated as the wrapper; the message is never rendered.
 *
 * viem BaseError is duck-typed the same way (string `shortMessage`, no viem
 * import). The rule applies at every cause depth: a ChainBankError whose cause
 * is an RpcRequestError must not fall through to `name: message`, because that
 * message carries the endpoint URL and the request body.
 */
export function describeErrorChain(error: unknown): string {
  if (error === undefined || error === null) {
    return 'Non-error value thrown';
  }

  const seen = new Set<object>();
  const parts: string[] = [];
  let current: unknown = error;

  for (let depth = 0; depth < MAX_ERROR_CHAIN_DEPTH; depth += 1) {
    if (current === undefined || current === null) {
      break;
    }
    if (typeof current === 'object' && seen.has(current)) {
      break;
    }
    if (typeof current === 'object') {
      seen.add(current);
    }

    parts.push(renderDiagnosticNode(current));
    current = typeof current === 'object' ? readCause(current) : undefined;
  }

  return parts.join(ERROR_CHAIN_SEPARATOR);
}

function renderDiagnosticNode(error: unknown): string {
  if (isChainBankError(error)) {
    return `${error.name} ${error.code}: ${error.message}`;
  }

  if (isPostgresDriverError(error)) {
    return renderPostgresDriverError(error);
  }

  if (isDrizzleQueryError(error)) {
    return 'DrizzleQueryError';
  }

  if (isViemBaseError(error)) {
    return renderViemBaseError(error);
  }

  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  if (typeof error === 'string') {
    return error;
  }

  return 'Non-error value thrown';
}

/**
 * `code` + `severity` are the pg-protocol error fields. Anything else with a
 * string `code` (ChainBankError, Node system errors) is not a driver error.
 */
interface PostgresDriverErrorShape {
  readonly code: string;
  readonly severity: string;
  readonly constraint?: unknown;
  readonly table?: unknown;
  readonly schema?: unknown;
  readonly detail?: unknown;
  readonly hint?: unknown;
}

function isPostgresDriverError(error: unknown): error is PostgresDriverErrorShape {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  return typeof Reflect.get(error, 'code') === 'string' && typeof Reflect.get(error, 'severity') === 'string';
}

function renderPostgresDriverError(error: PostgresDriverErrorShape): string {
  const parts = [`code=${error.code}`];
  for (const field of POSTGRES_DIAGNOSTIC_FIELDS) {
    const value = error[field];
    if (typeof value === 'string' && value.length > 0) {
      parts.push(`${field}=${value}`);
    }
  }
  return parts.join(' ');
}

/**
 * viem's BaseError always assigns a string `shortMessage`. RpcRequestError and
 * HttpRequestError also set `url`, `body`, and `metaMessages`, and fold those
 * into `message` (`URL: …` and `Request body: …`). `getUrl` strips only
 * basic-auth credentials, so a path token stays in `message`. A failed
 * `eth_sendRawTransaction` body is the signed raw transaction, which
 * AGENTS.md §11 forbids logging. Render `name`, `shortMessage`, `details`, and
 * `code` or `status` when those are strings or numbers. Never render
 * `message`, `metaMessages`, `url`, or `body`.
 */
type ViemBaseErrorShape = Error & {
  readonly shortMessage: string;
};

function isViemBaseError(error: unknown): error is ViemBaseErrorShape {
  return error instanceof Error && typeof Reflect.get(error, 'shortMessage') === 'string';
}

function renderViemBaseError(error: ViemBaseErrorShape): string {
  const parts = [`${error.name}: ${error.shortMessage}`];
  const details: unknown = Reflect.get(error, 'details');
  if (typeof details === 'string' && details.length > 0) {
    parts.push(`details=${details}`);
  }
  const code: unknown = Reflect.get(error, 'code');
  if (isLoggableScalar(code)) {
    parts.push(`code=${scalarText(code)}`);
  }
  const status: unknown = Reflect.get(error, 'status');
  if (isLoggableScalar(status)) {
    parts.push(`status=${scalarText(status)}`);
  }
  return parts.join(' ');
}

function isLoggableScalar(value: unknown): value is string | number {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  return typeof value === 'number' && Number.isFinite(value);
}

function scalarText(value: string | number): string {
  return typeof value === 'number' ? String(value) : value;
}

function isDrizzleQueryError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  if (Reflect.get(error, 'name') === 'DrizzleQueryError') {
    return true;
  }
  const constructor: unknown = Reflect.get(error, 'constructor');
  return typeof constructor === 'function' && constructor.name === 'DrizzleQueryError';
}

function readCause(error: object): unknown {
  if (!('cause' in error)) {
    return undefined;
  }
  return error.cause;
}
