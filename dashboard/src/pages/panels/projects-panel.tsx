import type { ProjectResource } from '../../api';
import { CollapsibleSection, COLLAPSE_STORAGE_KEYS } from '../../collapsible-section';
import { enabledBadge, partitionByEnabled, type LoadState } from '../../dashboard-shared';

export type ProjectsPanelProps = {
  readonly loadProjectsPanel: (activeToken: string) => Promise<void>;
  readonly token: string;
  readonly projectsState: LoadState;
  readonly projectsError: string | undefined;
  readonly projectsTotal: number;
  readonly projects: readonly ProjectResource[];
  readonly selectedProjectId: string;
  readonly setSelectedProjectId: (value: string) => void;
  readonly projectBusyId: string | undefined;
  readonly onToggleProject: (project: ProjectResource) => Promise<void>;
};

function ProjectCard({
  project,
  isSelected,
  busyId,
  onSelect,
  onToggle,
}: {
  readonly project: ProjectResource;
  readonly isSelected: boolean;
  readonly busyId: string | undefined;
  readonly onSelect: (projectId: string) => void;
  readonly onToggle: (project: ProjectResource) => Promise<void>;
}) {
  return (
    <article className={isSelected ? 'entity-card is-selected' : 'entity-card'}>
      <div className="entity-card-title">
        <h3>{project.name}</h3>
        <span className={enabledBadge(project.enabled)}>{project.enabled ? 'enabled' : 'disabled'}</span>
      </div>
      <p className="mono muted">{project.slug}</p>
      <div className="row">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            onSelect(project.id);
          }}
        >
          {isSelected ? 'Selected' : 'Select'}
        </button>
        <button
          type="button"
          className={project.enabled ? 'secondary' : undefined}
          disabled={busyId === project.id}
          onClick={() => void onToggle(project)}
        >
          {project.enabled ? 'Disable' : 'Enable'}
        </button>
      </div>
    </article>
  );
}

export function ProjectsPanel({
  loadProjectsPanel,
  token,
  projectsState,
  projectsError,
  projectsTotal,
  projects,
  selectedProjectId,
  setSelectedProjectId,
  projectBusyId,
  onToggleProject,
}: ProjectsPanelProps) {
  const { enabled, disabled } = partitionByEnabled(projects);

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="section-title">Projects</h2>
        <button type="button" className="secondary" onClick={() => void loadProjectsPanel(token)}>
          Reload
        </button>
      </div>
      {token === '' ? <p className="muted">Paste an operator token to load projects.</p> : null}
      {token !== '' && projectsState === 'loading' ? <p className="muted">Loading…</p> : null}
      {projectsState === 'error' ? <p className="error-inline">{projectsError}</p> : null}
      {projectsState === 'empty' ? (
        <p className="muted">No projects returned ({String(projectsTotal)} total).</p>
      ) : null}
      {projectsState === 'ready' ? (
        <>
          <p className="muted">
            {String(enabled.length)} enabled · {String(disabled.length)} disabled. Select one to scope
            environments and funding policy.
          </p>
          {enabled.length === 0 ? <p className="muted">No enabled projects.</p> : null}
          <div className="entity-grid">
            {enabled.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                isSelected={selectedProjectId === project.id}
                busyId={projectBusyId}
                onSelect={setSelectedProjectId}
                onToggle={onToggleProject}
              />
            ))}
          </div>
          <CollapsibleSection
            title="Disabled projects"
            count={disabled.length}
            storageKey={COLLAPSE_STORAGE_KEYS.disabledProjects}
          >
            <div className="entity-grid">
              {disabled.map((project) => (
                <ProjectCard
                  key={project.id}
                  project={project}
                  isSelected={selectedProjectId === project.id}
                  busyId={projectBusyId}
                  onSelect={setSelectedProjectId}
                  onToggle={onToggleProject}
                />
              ))}
            </div>
          </CollapsibleSection>
        </>
      ) : null}
    </section>
  );
}
