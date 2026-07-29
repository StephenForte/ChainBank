import { eq } from 'drizzle-orm';
import type {
  CredentialScope,
  CredentialScopeInsert,
  CredentialScopeRepository,
} from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { isUniqueViolation, withDatabaseErrors, type Database } from '../client.js';
import { apiCredentialScopes, type ApiCredentialScopeRow } from '../schema.js';

export function createCredentialScopeRepository(db: Database): CredentialScopeRepository {
  return {
    async listByCredentialId(credentialId: string): Promise<readonly CredentialScope[]> {
      return withDatabaseErrors('api_credential_scopes.listByCredentialId', async () => {
        const rows = await db.query.apiCredentialScopes.findMany({
          where: eq(apiCredentialScopes.credentialId, credentialId),
        });
        return rows.map(toCredentialScope);
      });
    },

    async insert(input: CredentialScopeInsert): Promise<CredentialScope> {
      return withDatabaseErrors('api_credential_scopes.insert', async () => {
        try {
          const [row] = await db
            .insert(apiCredentialScopes)
            .values({
              credentialId: input.credentialId,
              projectId: input.projectId,
              environmentId: input.environmentId ?? null,
            })
            .returning();

          if (row === undefined) {
            throw new ChainBankError('DATABASE_UNAVAILABLE', 'Credential scope insert returned no row');
          }
          return toCredentialScope(row);
        } catch (error) {
          if (error instanceof ChainBankError) {
            throw error;
          }
          if (isUniqueViolation(error)) {
            throw new ChainBankError(
              'SCOPE_ALREADY_ASSIGNED',
              'This credential already has an equivalent project/environment scope',
              {
                publicMessage: 'The credential is already scoped to this project or environment.',
                context: {
                  credentialId: input.credentialId,
                  projectId: input.projectId,
                  environmentId: input.environmentId,
                },
                cause: error,
              },
            );
          }
          throw error;
        }
      });
    },
  };
}

function toCredentialScope(row: ApiCredentialScopeRow): CredentialScope {
  return {
    id: row.id,
    credentialId: row.credentialId,
    projectId: row.projectId,
    environmentId: row.environmentId ?? undefined,
    createdAt: row.createdAt,
  };
}
