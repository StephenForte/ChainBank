import { eq } from 'drizzle-orm';
import type { Environment, EnvironmentInsert, EnvironmentRepository } from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { isUniqueViolation, withDatabaseErrors, type Database } from '../client.js';
import { environments, type EnvironmentRow } from '../schema.js';

export function createEnvironmentRepository(db: Database): EnvironmentRepository {
  return {
    async insert(input: EnvironmentInsert): Promise<Environment> {
      return withDatabaseErrors('environments.insert', async () => {
        try {
          const [row] = await db
            .insert(environments)
            .values({
              projectId: input.projectId,
              slug: input.slug,
              name: input.name.trim(),
            })
            .returning();

          if (row === undefined) {
            throw new ChainBankError('DATABASE_UNAVAILABLE', 'Environment insert returned no row');
          }
          return toEnvironment(row);
        } catch (error) {
          if (error instanceof ChainBankError) {
            throw error;
          }
          if (isUniqueViolation(error)) {
            throw new ChainBankError(
              'ENVIRONMENT_SLUG_CONFLICT',
              `Environment slug "${input.slug}" is already in use for this project`,
              {
                publicMessage: 'An environment with this slug already exists in the project.',
                context: { projectId: input.projectId, slug: input.slug },
                cause: error,
              },
            );
          }
          throw error;
        }
      });
    },

    async findById(id: string): Promise<Environment | undefined> {
      return withDatabaseErrors('environments.findById', async () => {
        const row = await db.query.environments.findFirst({ where: eq(environments.id, id) });
        return row === undefined ? undefined : toEnvironment(row);
      });
    },

    async setEnabled(id: string, enabled: boolean): Promise<Environment> {
      return withDatabaseErrors('environments.setEnabled', async () => {
        const [row] = await db
          .update(environments)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(environments.id, id))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('ENVIRONMENT_NOT_FOUND', `Environment ${id} was not found`);
        }
        return toEnvironment(row);
      });
    },
  };
}

export function toEnvironment(row: EnvironmentRow): Environment {
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toEnvironmentSummary(row: EnvironmentRow): {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
} {
  return {
    id: row.id,
    projectId: row.projectId,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
  };
}
