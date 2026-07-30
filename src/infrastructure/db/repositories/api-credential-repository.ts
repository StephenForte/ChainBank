import { asc, count, eq } from 'drizzle-orm';
import type { ApiCredential, ApiCredentialRepository, ApiCredentialSummary } from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { apiCredentials, type ApiCredentialRow } from '../schema.js';

export function createApiCredentialRepository(db: Database): ApiCredentialRepository {
  return {
    async findByTokenHash(tokenHash: string): Promise<ApiCredential | undefined> {
      return withDatabaseErrors('api_credentials.findByTokenHash', async () => {
        const row = await db.query.apiCredentials.findFirst({
          where: eq(apiCredentials.tokenHash, tokenHash),
        });
        if (row === undefined) {
          return undefined;
        }
        return toApiCredential(row);
      });
    },

    async findById(id: string): Promise<ApiCredentialSummary | undefined> {
      return withDatabaseErrors('api_credentials.findById', async () => {
        const row = await db.query.apiCredentials.findFirst({
          where: eq(apiCredentials.id, id),
        });
        return row === undefined ? undefined : toApiCredentialSummary(row);
      });
    },

    async list(pagination: {
      readonly limit: number;
      readonly offset: number;
    }): Promise<{ readonly items: readonly ApiCredentialSummary[]; readonly total: number }> {
      return withDatabaseErrors('api_credentials.list', async () => {
        const [totalRow] = await db.select({ value: count() }).from(apiCredentials);
        const rows = await db.query.apiCredentials.findMany({
          orderBy: [asc(apiCredentials.createdAt)],
          limit: pagination.limit,
          offset: pagination.offset,
        });
        return {
          items: rows.map(toApiCredentialSummary),
          total: Number(totalRow?.value ?? 0),
        };
      });
    },

    async disable(id: string, at: Date): Promise<ApiCredentialSummary> {
      return withDatabaseErrors('api_credentials.disable', async () => {
        const [row] = await db
          .update(apiCredentials)
          .set({ enabled: false, updatedAt: at })
          .where(eq(apiCredentials.id, id))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('CREDENTIAL_NOT_FOUND', `Credential ${id} was not found`);
        }
        return toApiCredentialSummary(row);
      });
    },

    async revoke(id: string, at: Date): Promise<ApiCredentialSummary> {
      return withDatabaseErrors('api_credentials.revoke', async () => {
        const [row] = await db
          .update(apiCredentials)
          .set({ enabled: false, revokedAt: at, updatedAt: at })
          .where(eq(apiCredentials.id, id))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('CREDENTIAL_NOT_FOUND', `Credential ${id} was not found`);
        }
        return toApiCredentialSummary(row);
      });
    },

    /**
     * Re-enables a disabled credential. Deliberately leaves `revoked_at`
     * untouched: revocation is terminal, and the application layer refuses to
     * re-enable a revoked credential rather than silently clearing the field.
     */
    async enable(id: string, at: Date): Promise<ApiCredentialSummary> {
      return withDatabaseErrors('api_credentials.enable', async () => {
        const [row] = await db
          .update(apiCredentials)
          .set({ enabled: true, updatedAt: at })
          .where(eq(apiCredentials.id, id))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('CREDENTIAL_NOT_FOUND', `Credential ${id} was not found`);
        }
        return toApiCredentialSummary(row);
      });
    },

    async touchLastUsed(id: string, at: Date): Promise<void> {
      await withDatabaseErrors('api_credentials.touchLastUsed', async () => {
        await db.update(apiCredentials).set({ lastUsedAt: at }).where(eq(apiCredentials.id, id));
      });
    },
  };
}

function toApiCredential(row: ApiCredentialRow): ApiCredential {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    enabled: row.enabled,
    revokedAt: row.revokedAt ?? undefined,
  };
}

function toApiCredentialSummary(row: ApiCredentialRow): ApiCredentialSummary {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    tokenPrefix: row.tokenPrefix,
    enabled: row.enabled,
    revokedAt: row.revokedAt ?? undefined,
    lastUsedAt: row.lastUsedAt ?? undefined,
    createdAt: row.createdAt,
  };
}
