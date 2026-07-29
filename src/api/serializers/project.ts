import type { Environment, Project } from '../../app/ports.js';

export interface SerializedProject {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SerializedEnvironment {
  readonly id: string;
  readonly projectId: string;
  readonly slug: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function serializeProject(project: Project): SerializedProject {
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    enabled: project.enabled,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  };
}

export function serializeEnvironment(environment: Environment): SerializedEnvironment {
  return {
    id: environment.id,
    projectId: environment.projectId,
    slug: environment.slug,
    name: environment.name,
    enabled: environment.enabled,
    createdAt: environment.createdAt.toISOString(),
    updatedAt: environment.updatedAt.toISOString(),
  };
}
