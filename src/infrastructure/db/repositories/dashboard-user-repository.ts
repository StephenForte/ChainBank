import { asc, count, eq, sql } from 'drizzle-orm';
import type {
  DashboardUserListPage,
  DashboardUserRecord,
  DashboardUserRepository,
  DashboardUserSummary,
} from '../../../app/ports.js';
import { isScryptPasswordParams, type ScryptPasswordParams } from '../../../domain/auth/password.js';
import { ChainBankError } from '../../../domain/errors.js';
import { isUniqueViolation, withDatabaseErrors, type Database } from '../client.js';
import { dashboardUsers, type DashboardUserRow } from '../schema.js';

export function createDashboardUserRepository(db: Database): DashboardUserRepository {
  return {
    async findByEmail(email): Promise<DashboardUserRecord | undefined> {
      return withDatabaseErrors('dashboard_users.findByEmail', async () => {
        const [row] = await db
          .select()
          .from(dashboardUsers)
          .where(sql`lower(${dashboardUsers.email}) = ${email}`)
          .limit(1);
        return row === undefined ? undefined : toRecord(row);
      });
    },

    async findById(id): Promise<DashboardUserRecord | undefined> {
      return withDatabaseErrors('dashboard_users.findById', async () => {
        const [row] = await db.select().from(dashboardUsers).where(eq(dashboardUsers.id, id)).limit(1);
        return row === undefined ? undefined : toRecord(row);
      });
    },

    async list(pagination): Promise<DashboardUserListPage> {
      return withDatabaseErrors('dashboard_users.list', async () => {
        const [totalRow] = await db.select({ value: count() }).from(dashboardUsers);
        const rows = await db
          .select()
          .from(dashboardUsers)
          .orderBy(asc(dashboardUsers.createdAt))
          .limit(pagination.limit)
          .offset(pagination.offset);
        return {
          items: rows.map(toSummary),
          total: Number(totalRow?.value ?? 0),
        };
      });
    },

    async insert(input): Promise<DashboardUserSummary> {
      return withDatabaseErrors('dashboard_users.insert', async () => {
        try {
          const [row] = await db
            .insert(dashboardUsers)
            .values({
              email: input.email,
              displayName: input.displayName,
              role: input.role,
              passwordHash: input.passwordHash,
              passwordParams: input.passwordParams,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .returning();
          if (row === undefined) {
            throw new Error('Dashboard user insert returned no row.');
          }
          return toSummary(row);
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new ChainBankError('USER_EMAIL_CONFLICT', 'Dashboard user email is already registered', {
              publicMessage: 'A user with that email already exists.',
            });
          }
          throw error;
        }
      });
    },

    async update(id, patch): Promise<DashboardUserSummary | undefined> {
      return withDatabaseErrors('dashboard_users.update', async () => {
        const [row] = await db
          .update(dashboardUsers)
          .set({
            ...(patch.role === undefined ? {} : { role: patch.role }),
            ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }),
            ...(patch.passwordHash === undefined ? {} : { passwordHash: patch.passwordHash }),
            ...(patch.passwordParams === undefined ? {} : { passwordParams: patch.passwordParams }),
            updatedAt: patch.updatedAt,
          })
          .where(eq(dashboardUsers.id, id))
          .returning();
        return row === undefined ? undefined : toSummary(row);
      });
    },

    async recordLogin(id, at): Promise<void> {
      await withDatabaseErrors('dashboard_users.recordLogin', async () => {
        await db
          .update(dashboardUsers)
          .set({ lastLoginAt: at, updatedAt: at })
          .where(eq(dashboardUsers.id, id));
      });
    },
  };
}

function toSummary(row: DashboardUserRow): DashboardUserSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastLoginAt: row.lastLoginAt ?? undefined,
  };
}

function toRecord(row: DashboardUserRow): DashboardUserRecord {
  return {
    ...toSummary(row),
    passwordHash: row.passwordHash,
    passwordParams: parsePasswordParams(row.passwordParams),
  };
}

function parsePasswordParams(value: unknown): ScryptPasswordParams {
  if (!isScryptPasswordParams(value)) {
    throw new ChainBankError(
      'INTERNAL_ERROR',
      'Stored dashboard password parameters are not scrypt parameters',
    );
  }
  return value;
}
