import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppInstance } from '../types.js';
import { ChainBankError, describeUnknownError, isChainBankError } from '../../domain/errors.js';

interface ErrorResponseBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
  readonly requestId: string;
}

/**
 * Single exit point for every error leaving the API.
 *
 * Clients receive a stable code and a vetted message. Stack traces, driver
 * text, provider responses, and configuration values stay in the server log,
 * correlated to the response by request ID.
 */
export function registerErrorHandler(app: AppInstance): void {
  app.setErrorHandler((error: unknown, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = request.id;

    if (isChainBankError(error)) {
      logByCategory(request, error);
      return reply
        .status(error.httpStatus)
        .send(body(error.code, error.publicMessage, requestId));
    }

    // Schema validation rejections arrive as Fastify errors with a validation
    // array. The details name request fields only, never internal state.
    if (isFastifyValidationError(error)) {
      request.log.info({ validation: error.validation }, 'Request failed schema validation');
      return reply
        .status(400)
        .send(body('INVALID_REQUEST', 'The request did not match the expected schema.', requestId));
    }

    if (isRateLimitError(error)) {
      return reply
        .status(429)
        .send(body('RATE_LIMITED', 'Too many requests. Please retry later.', requestId));
    }

    request.log.error({ detail: describeUnknownError(error) }, 'Unhandled error');
    return reply
      .status(500)
      .send(body('INTERNAL_ERROR', 'An unexpected internal error occurred.', requestId));
  });

}

export function notFoundBody(requestId: string): ErrorResponseBody {
  return body('NOT_FOUND', 'The requested resource does not exist.', requestId);
}

function body(code: string, message: string, requestId: string): ErrorResponseBody {
  return { error: { code, message }, requestId };
}

function logByCategory(request: FastifyRequest, error: ChainBankError): void {
  const payload = {
    code: error.code,
    category: error.category,
    detail: error.message,
    context: error.context,
  };

  switch (error.category) {
    case 'validation':
    case 'not_found':
      request.log.info(payload, 'Request rejected');
      return;
    case 'authentication':
    case 'authorization':
      // Denials are security-relevant and always recorded at warn.
      request.log.warn(payload, 'Request denied');
      return;
    case 'conflict':
      request.log.warn(payload, 'Request conflicted with current state');
      return;
    case 'dependency_unavailable':
    case 'provider_retriable':
      request.log.error(payload, 'Dependency failure');
      return;
    case 'internal':
      request.log.error(payload, 'Internal error');
      return;
  }
}

function isFastifyValidationError(error: unknown): error is { validation: readonly unknown[] } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'validation' in error &&
    Array.isArray((error as { validation: unknown }).validation)
  );
}

function isRateLimitError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'statusCode' in error &&
    (error as { statusCode: unknown }).statusCode === 429
  );
}
