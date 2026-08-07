import type { ProjectResource } from '../api';
import { enabledBadge, type LoadState } from '../dashboard-shared';

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

export function ProjectsPanel({ loadProjectsPanel, token, projectsState, projectsError, projectsTotal, projects, selectedProjectId, setSelectedProjectId, projectBusyId, onToggleProject }) {
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
        Showing {String(projects.length)} of {String(projectsTotal)} projects. Select one to
        scope environments and funding policy.
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Slug</th>
              <th>Name</th>
              <th>Enabled</th>
              <th>Select</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => (
              <tr
                key={project.id}
                className={selectedProjectId === project.id ? 'row-selected' : undefined}
              >
                <td className="mono">{project.slug}</td>
                <td>{project.name}</td>
                <td>
                  <span className={enabledBadge(project.enabled)}>
                    {project.enabled ? 'enabled' : 'disabled'}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => {
                      setSelectedProjectId(project.id);
                    }}
                  >
                    {selectedProjectId === project.id ? 'Selected' : 'Select'}
                  </button>
                </td>
                <td>
                  <button
                    type="button"
                    className={project.enabled ? 'secondary' : undefined}
                    disabled={projectBusyId === project.id}
                    onClick={() => void onToggleProject(project)}
                  >
                    {project.enabled ? 'Disable' : 'Enable'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  ) : null}
  );
}
