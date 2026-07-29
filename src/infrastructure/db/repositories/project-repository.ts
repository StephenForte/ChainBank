import { asc, count, eq, inArray } from 'drizzle-orm';
import type { Project, ProjectInsert, ProjectListPage, ProjectRepository } from '../../../app/ports.js';
import { ChainBankError } from '../../../domain/errors.js';
import { isUniqueViolation, withDatabaseErrors, type Database } from '../client.js';
import { projects, type ProjectRow } from '../schema.js';

export function createProjectRepository(db: Database): ProjectRepository {
  return {
    async insert(input: ProjectInsert): Promise<Project> {
      return withDatabaseErrors('projects.insert', async () => {
        try {
          const [row] = await db
            .insert(projects)
            .values({ slug: input.slug, name: input.name.trim() })
            .returning();

          if (row === undefined) {
            throw new ChainBankError('DATABASE_UNAVAILABLE', 'Project insert returned no row');
          }
          return toProject(row);
        } catch (error) {
          if (error instanceof ChainBankError) {
            throw error;
          }
          if (isUniqueViolation(error)) {
            throw new ChainBankError(
              'PROJECT_SLUG_CONFLICT',
              `Project slug "${input.slug}" is already in use`,
              {
                publicMessage: 'A project with this slug already exists.',
                context: { slug: input.slug },
                cause: error,
              },
            );
          }
          throw error;
        }
      });
    },

    async findById(id: string): Promise<Project | undefined> {
      return withDatabaseErrors('projects.findById', async () => {
        const row = await db.query.projects.findFirst({ where: eq(projects.id, id) });
        return row === undefined ? undefined : toProject(row);
      });
    },

    async findBySlug(slug: string): Promise<Project | undefined> {
      return withDatabaseErrors('projects.findBySlug', async () => {
        const row = await db.query.projects.findFirst({ where: eq(projects.slug, slug) });
        return row === undefined ? undefined : toProject(row);
      });
    },

    async list(pagination: { readonly limit: number; readonly offset: number }): Promise<ProjectListPage> {
      return withDatabaseErrors('projects.list', async () => {
        const [totalRow] = await db.select({ value: count() }).from(projects);
        const rows = await db.query.projects.findMany({
          orderBy: [asc(projects.createdAt)],
          limit: pagination.limit,
          offset: pagination.offset,
        });
        return {
          items: rows.map(toProject),
          total: Number(totalRow?.value ?? 0),
        };
      });
    },

    async listByIds(ids: readonly string[]): Promise<readonly Project[]> {
      if (ids.length === 0) {
        return [];
      }
      return withDatabaseErrors('projects.listByIds', async () => {
        const rows = await db.query.projects.findMany({
          where: inArray(projects.id, [...ids]),
          orderBy: [asc(projects.createdAt)],
        });
        return rows.map(toProject);
      });
    },

    async setEnabled(id: string, enabled: boolean): Promise<Project> {
      return withDatabaseErrors('projects.setEnabled', async () => {
        const [row] = await db
          .update(projects)
          .set({ enabled, updatedAt: new Date() })
          .where(eq(projects.id, id))
          .returning();

        if (row === undefined) {
          throw new ChainBankError('PROJECT_NOT_FOUND', `Project ${id} was not found`);
        }
        return toProject(row);
      });
    },
  };
}

export function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toProjectSummary(row: ProjectRow): {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
} {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    enabled: row.enabled,
  };
}
