import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import type { Logger } from '../observability/logger.js';

/**
 * The Fastify instance type this service actually constructs.
 *
 * Supplying a concrete pino logger narrows Fastify's logger generic, so route
 * modules must refer to this alias rather than the default `FastifyInstance`.
 */
export type AppInstance = FastifyInstance<Server, IncomingMessage, ServerResponse, Logger>;
