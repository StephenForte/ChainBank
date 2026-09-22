import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiClientError,
  bumpDashboardSessionEpoch,
  fetchCurrentUser,
  loginWithPassword,
  logoutSession,
  setDashboardUnauthorizedHandler,
  type CurrentUserResponse,
} from '../api';

export type SessionUser = CurrentUserResponse['user'];

export type SessionStatus = 'unknown' | 'signed-out' | 'signed-in';

/** Shown after a 401 from a call that required the live session. */
export const SESSION_ENDED_MESSAGE = 'Your session ended, sign in again';

export type SessionController = {
  readonly status: SessionStatus;
  readonly user: SessionUser | undefined;
  readonly permissions: readonly string[];
  readonly signedOutReason: string | undefined;
  readonly login: (email: string, password: string) => Promise<void>;
  readonly logout: () => Promise<void>;
};

export function useSession(): SessionController {
  const [status, setStatus] = useState<SessionStatus>('unknown');
  const [user, setUser] = useState<SessionUser | undefined>();
  const [permissions, setPermissions] = useState<readonly string[]>([]);
  const [signedOutReason, setSignedOutReason] = useState<string | undefined>();
  const statusRef = useRef<SessionStatus>('unknown');

  const applySignedOut = useCallback((reason: string | undefined, fromSignedIn: boolean) => {
    bumpDashboardSessionEpoch();
    setUser(undefined);
    setPermissions([]);
    setSignedOutReason(fromSignedIn ? (reason ?? SESSION_ENDED_MESSAGE) : reason);
    statusRef.current = 'signed-out';
    setStatus('signed-out');
  }, []);

  const endSignedInSession = useCallback(() => {
    if (statusRef.current !== 'signed-in') {
      return;
    }
    applySignedOut(SESSION_ENDED_MESSAGE, true);
  }, [applySignedOut]);

  const loadMe = useCallback(async (): Promise<SessionStatus> => {
    try {
      const next = await fetchCurrentUser();
      setUser(next.user);
      setPermissions(next.permissions);
      setSignedOutReason(undefined);
      statusRef.current = 'signed-in';
      setStatus('signed-in');
      return 'signed-in';
    } catch (caught) {
      if (caught instanceof ApiClientError && caught.status === 401) {
        applySignedOut(undefined, false);
        return 'signed-out';
      }
      const message = caught instanceof Error ? caught.message : 'Could not check the session.';
      applySignedOut(message, false);
      return 'signed-out';
    }
  }, [applySignedOut]);

  useEffect(() => {
    setDashboardUnauthorizedHandler(endSignedInSession);
    void loadMe();
    return () => {
      setDashboardUnauthorizedHandler(undefined);
    };
  }, [endSignedInSession, loadMe]);

  const login = useCallback(
    async (email: string, password: string): Promise<void> => {
      bumpDashboardSessionEpoch();
      await loginWithPassword(email, password);
      const next = await loadMe();
      if (next !== 'signed-in') {
        throw new Error('Sign-in did not start a session.');
      }
    },
    [loadMe],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await logoutSession();
    } finally {
      applySignedOut(undefined, false);
    }
  }, [applySignedOut]);

  return { status, user, permissions, signedOutReason, login, logout };
}
