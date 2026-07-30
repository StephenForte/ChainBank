import type { ApiCredentialSummary } from '../../app/ports.js';

export function serializeCredentialSummary(credential: ApiCredentialSummary): {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly tokenPrefix: string;
  readonly enabled: boolean;
  readonly revokedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly createdAt: string;
} {
  return {
    id: credential.id,
    name: credential.name,
    role: credential.role,
    tokenPrefix: credential.tokenPrefix,
    enabled: credential.enabled,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
    createdAt: credential.createdAt.toISOString(),
  };
}
