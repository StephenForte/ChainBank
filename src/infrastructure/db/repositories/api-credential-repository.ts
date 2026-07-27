import { eq } from 'drizzle-orm';
import type { ApiCredential, ApiCredentialRepository } from '../../../app/ports.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { apiCredentials } from '../schema.js';

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
        return {
          id: row.id,
          name: row.name,
          role: row.role,
          enabled: row.enabled,
          revokedAt: row.revokedAt ?? undefined,
        };
      });
    },

    async touchLastUsed(id: string, at: Date): Promise<void> {
      await withDatabaseErrors('api_credentials.touchLastUsed', async () => {
        await db.update(apiCredentials).set({ lastUsedAt: at }).where(eq(apiCredentials.id, id));
      });
    },
  };
}
