import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  apiCredentialScopes,
  apiCredentials,
  environments,
  projects,
} from '../../src/infrastructure/db/schema.js';
import { integrationEnabled } from '../support/integration-setup.js';
import {
  createIntegrationDatabase,
  isPgError,
  seedPhase1Fixtures,
  truncatePhase1Tables,
  type IntegrationDatabaseHandle,
  type Phase1Seed,
} from '../support/integration-db.js';

describe.skipIf(!integrationEnabled)('api_credential_scopes constraints', () => {
  let handle: IntegrationDatabaseHandle;
  let seed: Phase1Seed;
  let credentialId: string;

  beforeAll(async () => {
    handle = createIntegrationDatabase();
    await handle.applyMigrations();
  });

  beforeEach(async () => {
    await truncatePhase1Tables(handle.pool);
    seed = await seedPhase1Fixtures(handle.db);

    const [credential] = await handle.db
      .insert(apiCredentials)
      .values({
        name: `svc-test-${randomUUID()}`,
        role: 'project-service',
        tokenHash: `hash-${randomUUID()}`,
        tokenPrefix: 'cbk_test',
      })
      .returning({ id: apiCredentials.id });

    if (credential === undefined) {
      throw new Error('Expected credential row');
    }
    credentialId = credential.id;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('allows one project-wide scope row per credential and project', async () => {
    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: seed.projectId,
        environmentId: null,
      }),
    ).resolves.toBeDefined();

    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: seed.projectId,
        environmentId: null,
      }),
    ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
  });

  it('allows one environment-specific scope row per credential, project, and environment', async () => {
    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: seed.projectId,
        environmentId: seed.environmentId,
      }),
    ).resolves.toBeDefined();

    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: seed.projectId,
        environmentId: seed.environmentId,
      }),
    ).rejects.toSatisfy((error: unknown) => isPgError(error, '23505'));
  });

  it('allows project-wide and environment-specific scopes for the same project', async () => {
    await handle.db.insert(apiCredentialScopes).values({
      credentialId,
      projectId: seed.projectId,
      environmentId: null,
    });

    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: seed.projectId,
        environmentId: seed.environmentId,
      }),
    ).resolves.toBeDefined();
  });

  it('rejects scopes referencing missing credential, project, or environment rows', async () => {
    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId: randomUUID(),
        projectId: seed.projectId,
        environmentId: null,
      }),
    ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: randomUUID(),
        environmentId: null,
      }),
    ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));

    await expect(
      handle.db.insert(apiCredentialScopes).values({
        credentialId,
        projectId: seed.projectId,
        environmentId: randomUUID(),
      }),
    ).rejects.toSatisfy((error: unknown) => isPgError(error, '23503'));
  });

  it('cascades scope deletion when the credential is removed', async () => {
    const [scope] = await handle.db
      .insert(apiCredentialScopes)
      .values({
        credentialId,
        projectId: seed.projectId,
        environmentId: null,
      })
      .returning({ id: apiCredentialScopes.id });

    if (scope === undefined) {
      throw new Error('Expected scope row');
    }

    await handle.db.delete(apiCredentials).where(eq(apiCredentials.id, credentialId));

    const remaining = await handle.db.query.apiCredentialScopes.findMany({
      where: eq(apiCredentialScopes.id, scope.id),
    });
    expect(remaining).toHaveLength(0);
  });

  it('preserves project and environment rows when disabled via update', async () => {
    await handle.db.update(projects).set({ enabled: false }).where(eq(projects.id, seed.projectId));

    await handle.db
      .update(environments)
      .set({ enabled: false })
      .where(eq(environments.id, seed.environmentId));

    const projectRow = await handle.db.query.projects.findFirst({
      where: eq(projects.id, seed.projectId),
    });
    const environmentRow = await handle.db.query.environments.findFirst({
      where: eq(environments.id, seed.environmentId),
    });

    expect(projectRow?.enabled).toBe(false);
    expect(environmentRow?.enabled).toBe(false);
    expect(projectRow?.id).toBe(seed.projectId);
    expect(environmentRow?.id).toBe(seed.environmentId);
  });
});
