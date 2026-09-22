import { createContext, useContext, type ReactNode } from 'react';

/**
 * Permissions from `GET /v1/auth/me`. Absent means the caller has not signed
 * in through `App`, so write controls stay out of the DOM (deny by default).
 */
const PermissionsContext = createContext<readonly string[]>([]);

export function PermissionsProvider(props: {
  readonly permissions: readonly string[];
  readonly children: ReactNode;
}) {
  return (
    <PermissionsContext.Provider value={props.permissions}>{props.children}</PermissionsContext.Provider>
  );
}

export function usePermissions(): readonly string[] {
  return useContext(PermissionsContext);
}

export function useHasPermission(permission: string): boolean {
  return usePermissions().includes(permission);
}
