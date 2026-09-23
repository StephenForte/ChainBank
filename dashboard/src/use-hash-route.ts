import { useEffect, useState } from 'react';

export const DASHBOARD_ROUTES = [
  'overview',
  'treasuries',
  'wallets',
  'add-wallet',
  'funding',
  'reconciliation',
  'alerts',
  'email',
  'admin',
] as const;

export type DashboardRoute = (typeof DASHBOARD_ROUTES)[number];

const ROUTE_SET: ReadonlySet<string> = new Set(DASHBOARD_ROUTES);

/** Unknown or empty hash renders overview. `#/wallets` and `#wallets` both match. */
export function parseHashRoute(hash: string): DashboardRoute {
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  const segment = body.replace(/^\/+/, '').split('/')[0] ?? '';
  if (ROUTE_SET.has(segment)) {
    return segment as DashboardRoute;
  }
  return 'overview';
}

export function useHashRoute(): DashboardRoute {
  const [route, setRoute] = useState<DashboardRoute>(() => parseHashRoute(window.location.hash));

  useEffect(() => {
    const onChange = (): void => {
      setRoute(parseHashRoute(window.location.hash));
    };
    window.addEventListener('hashchange', onChange);
    return () => {
      window.removeEventListener('hashchange', onChange);
    };
  }, []);

  return route;
}
