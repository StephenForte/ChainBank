import { ChainBankError, describeErrorChain, describeUnknownError } from '../src/domain/errors.js';

/**
 * Which ChainBankError field the first line uses.
 *
 * `create-dashboard-user` already prints `publicMessage`. `issue-credential`
 * already prints `message`. Those fields stay. A non-ChainBankError whose
 * message `describeErrorChain` refuses to render is not copied onto the
 * headline either: that message is the query, the connection string, or the RPC URL.
 */
export type CliChainBankHeadline = 'publicMessage' | 'message';

/**
 * How a non-ChainBankError is named on the first line.
 *
 * `message` is create-dashboard-user (Error.message, otherwise describeUnknownError).
 * `describeUnknown` is issue-credential (describeUnknownError for everything else).
 */
export type CliOtherErrorHeadline = 'message' | 'describeUnknown';

export interface CliFailureFormat {
  readonly summary: string;
  readonly chainBankHeadline: CliChainBankHeadline;
  readonly otherErrorHeadline: CliOtherErrorHeadline;
}

/**
 * Two-line stderr text for a setup-script failure.
 *
 * The second line is only `describeErrorChain`. That renderer omits node-postgres
 * and Drizzle messages (they can carry the connection string or the query) and
 * omits viem request messages (they carry the RPC URL). Callers must not append
 * a cause's own `message`.
 */
export function formatCliFailure(error: unknown, format: CliFailureFormat): string {
  return `${format.summary}: ${headlineDetail(error, format)}\nCause: ${describeErrorChain(error)}`;
}

function headlineDetail(error: unknown, format: CliFailureFormat): string {
  if (error instanceof ChainBankError) {
    return format.chainBankHeadline === 'publicMessage' ? error.publicMessage : error.message;
  }
  // describeErrorChain drops drizzle, driver, and viem messages. Putting
  // error.message back on the headline would undo that (SQL, bound parameters,
  // connection strings, RPC URLs). Use the chain's first node instead.
  if (error instanceof Error && isMessageOmittedFromChain(error)) {
    const [head] = describeErrorChain(error).split(' <- ');
    return head ?? 'Non-error value thrown';
  }
  if (format.otherErrorHeadline === 'message' && error instanceof Error) {
    return error.message;
  }
  return describeUnknownError(error);
}

function isMessageOmittedFromChain(error: Error): boolean {
  if (error.message.length === 0) {
    return false;
  }
  return !describeErrorChain(error).includes(error.message);
}
