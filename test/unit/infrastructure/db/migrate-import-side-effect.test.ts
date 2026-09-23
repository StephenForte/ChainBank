import { afterEach, describe, expect, it, vi } from 'vitest';

const loadDotEnvFile = vi.hoisted(() => vi.fn());
const loadMigrateConfig = vi.hoisted(() =>
  vi.fn(() => ({
    environment: 'local' as const,
    logLevel: 'error' as const,
    database: {
      url: 'postgres://127.0.0.1:1/none',
      poolMax: 1,
      useSsl: false,
      sslCertificateAuthority: undefined,
    },
  })),
);
const createDatabase = vi.hoisted(() =>
  vi.fn(() => ({
    db: {},
    pool: {
      query: vi.fn(() => Promise.resolve({ rows: [{ ok: 1 }] })),
    },
    close: vi.fn(() => Promise.resolve()),
  })),
);
const migrate = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock('../../../../src/config/load-dotenv.js', () => ({
  loadDotEnvFile,
}));

vi.mock('../../../../src/config/load-migrate-config.js', () => ({
  loadMigrateConfig,
}));

vi.mock('../../../../src/infrastructure/db/client.js', () => ({
  createDatabase,
  describeDatabaseTlsPin: () => ({}),
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate,
}));

async function flushImportSideEffects(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('migrations module import', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('does not read .env, open a database, or apply migrations', async () => {
    const folder = await import('../../../../src/infrastructure/db/migrations-folder.js');
    expect(folder.MIGRATIONS_FOLDER).toBe('drizzle');
    expect(loadDotEnvFile).not.toHaveBeenCalled();
    expect(loadMigrateConfig).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();

    await import('../../../../src/infrastructure/db/migrate.js');
    await flushImportSideEffects();

    expect(loadDotEnvFile).not.toHaveBeenCalled();
    expect(loadMigrateConfig).not.toHaveBeenCalled();
    expect(createDatabase).not.toHaveBeenCalled();
    expect(migrate).not.toHaveBeenCalled();
  });
});
