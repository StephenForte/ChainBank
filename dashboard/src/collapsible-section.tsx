import { useState, type ReactNode } from 'react';

/**
 * Per-block collapse memory. Same 'true'/'false' localStorage shape as
 * `storeReconciliationDetailExpanded`. Default is collapsed when the key is absent.
 */
export const COLLAPSE_STORAGE_KEYS = {
  readinessDetail: 'chainbank.collapse.readinessDetail',
  disabledProjects: 'chainbank.collapse.disabledProjects',
  disabledEnvironments: 'chainbank.collapse.disabledEnvironments',
  disabledWallets: 'chainbank.collapse.disabledWallets',
  disabledWalletPolicies: 'chainbank.collapse.disabledWalletPolicies',
  treasuryAutoFunding: 'chainbank.collapse.treasuryAutoFunding',
} as const;

export function treasuryDetailStorageKey(treasuryId: string): string {
  return `chainbank.collapse.treasury.${treasuryId}`;
}

export function policyDetailStorageKey(walletId: string): string {
  return `chainbank.collapse.policy.${walletId}`;
}

export type CollapsibleSectionProps = {
  readonly title: string;
  readonly count?: number;
  readonly defaultOpen?: boolean;
  /** Uncontrolled persistence. Ignored when `open` is passed. */
  readonly storageKey?: string;
  /** Controlled open state. Parent owns persistence (reconciliation detail, acknowledged findings). */
  readonly open?: boolean;
  readonly onToggle?: () => void;
  /** Applied to the body so callers can prove the region is absent while collapsed. */
  readonly bodyId?: string;
  readonly children: ReactNode;
};

function readStoredOpen(storageKey: string): boolean | undefined {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === 'true') {
      return true;
    }
    if (value === 'false') {
      return false;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function writeStoredOpen(storageKey: string, open: boolean): void {
  try {
    localStorage.setItem(storageKey, open ? 'true' : 'false');
  } catch {
    // localStorage may be unavailable; the in-memory toggle still works.
  }
}

/**
 * The one +/− control. Do not put unacknowledged critical findings or the
 * dark-chain warning here — those stay visible (C20, C30).
 */
export function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  storageKey,
  open,
  onToggle,
  bodyId,
  children,
}: CollapsibleSectionProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(() => {
    if (storageKey !== undefined) {
      const stored = readStoredOpen(storageKey);
      if (stored !== undefined) {
        return stored;
      }
    }
    return defaultOpen;
  });

  if (count === 0) {
    return null;
  }

  const isControlled = open !== undefined;
  const isOpen = isControlled ? open : uncontrolledOpen;
  const label = count === undefined ? title : `${title} (${String(count)})`;

  function toggle(): void {
    if (isControlled) {
      onToggle?.();
      return;
    }
    setUncontrolledOpen((previous) => {
      const next = !previous;
      if (storageKey !== undefined) {
        writeStoredOpen(storageKey, next);
      }
      return next;
    });
  }

  return (
    <div className="collapse-block">
      <button
        type="button"
        className="collapse-toggle"
        aria-expanded={isOpen}
        {...(bodyId !== undefined ? { 'aria-controls': bodyId } : {})}
        onClick={toggle}
      >
        <span className="collapse-mark" aria-hidden="true">
          {isOpen ? '−' : '+'}
        </span>
        {label}
      </button>
      {isOpen ? (
        <div className="collapse-body" id={bodyId}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
