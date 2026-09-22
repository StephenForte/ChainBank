import type { DashboardSessionRepository } from '../ports.js';

export interface LogoutDependencies {
  readonly sessions: DashboardSessionRepository;
}

/** Revokes the presented session. A second logout is a no-op at the row. */
export async function logout(
  dependencies: LogoutDependencies,
  input: { readonly sessionId: string; readonly now: Date },
): Promise<void> {
  await dependencies.sessions.revoke(input.sessionId, input.now);
}
