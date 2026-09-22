import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { DashboardSessionRecord, DashboardSessionRepository } from '../../../app/ports.js';
import { withDatabaseErrors, type Database } from '../client.js';
import { dashboardSessions, type DashboardSessionRow } from '../schema.js';

export function createDashboardSessionRepository(db: Database): DashboardSessionRepository {
  return {
    async insert(input): Promise<DashboardSessionRecord> {
      return withDatabaseErrors('dashboard_sessions.insert', async () => {
        const [row] = await db
          .insert(dashboardSessions)
          .values({
            userId: input.userId,
            tokenHash: input.tokenHash,
            createdAt: input.createdAt,
            expiresAt: input.expiresAt,
            lastSeenAt: input.lastSeenAt,
          })
          .returning();
        if (row === undefined) {
          throw new Error('Dashboard session insert returned no row.');
        }
        return toSession(row);
      });
    },

    async findByTokenHash(tokenHash): Promise<DashboardSessionRecord | undefined> {
      return withDatabaseErrors('dashboard_sessions.findByTokenHash', async () => {
        const [row] = await db
          .select()
          .from(dashboardSessions)
          .where(eq(dashboardSessions.tokenHash, tokenHash))
          .limit(1);
        return row === undefined ? undefined : toSession(row);
      });
    },

    async touchIfActive(input): Promise<boolean> {
      return withDatabaseErrors('dashboard_sessions.touchIfActive', async () => {
        const [row] = await db
          .update(dashboardSessions)
          .set({ lastSeenAt: input.now })
          .where(
            and(
              eq(dashboardSessions.id, input.id),
              isNull(dashboardSessions.revokedAt),
              gt(dashboardSessions.expiresAt, input.now),
              gt(dashboardSessions.lastSeenAt, input.idleCutoff),
            ),
          )
          .returning({ id: dashboardSessions.id });
        return row !== undefined;
      });
    },

    async revoke(id, at): Promise<void> {
      await withDatabaseErrors('dashboard_sessions.revoke', async () => {
        await db
          .update(dashboardSessions)
          .set({ revokedAt: at })
          .where(and(eq(dashboardSessions.id, id), isNull(dashboardSessions.revokedAt)));
      });
    },

    async revokeOthers(userId, exceptSessionId, at): Promise<void> {
      await withDatabaseErrors('dashboard_sessions.revokeOthers', async () => {
        await db
          .update(dashboardSessions)
          .set({ revokedAt: at })
          .where(
            and(
              eq(dashboardSessions.userId, userId),
              ne(dashboardSessions.id, exceptSessionId),
              isNull(dashboardSessions.revokedAt),
            ),
          );
      });
    },
  };
}

function toSession(row: DashboardSessionRow): DashboardSessionRecord {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastSeenAt: row.lastSeenAt,
    revokedAt: row.revokedAt ?? undefined,
  };
}
