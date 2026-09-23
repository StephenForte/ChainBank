import type { ReactNode } from 'react';

type IconProps = {
  readonly children: ReactNode;
};

function Icon({ children }: IconProps) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconOverview() {
  return (
    <Icon>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </Icon>
  );
}

export function IconTreasuries() {
  return (
    <Icon>
      <path d="M3 10h18" />
      <path d="M5 10V7l7-4 7 4v3" />
      <path d="M6 10v8" />
      <path d="M10 10v8" />
      <path d="M14 10v8" />
      <path d="M18 10v8" />
      <path d="M4 18h16" />
    </Icon>
  );
}

export function IconWallets() {
  return (
    <Icon>
      <rect x="3" y="6" width="18" height="13" rx="2" />
      <path d="M3 10h18" />
      <path d="M16 15h2" />
    </Icon>
  );
}

export function IconAddWallet() {
  return (
    <Icon>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  );
}

export function IconFunding() {
  return (
    <Icon>
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M5 21h14" />
    </Icon>
  );
}

export function IconReconciliation() {
  return (
    <Icon>
      <path d="M4 7h11" />
      <path d="M12 4l3 3-3 3" />
      <path d="M20 17H9" />
      <path d="M12 20l-3-3 3-3" />
    </Icon>
  );
}

export function IconAlerts() {
  return (
    <Icon>
      <path d="M6 16V10a6 6 0 1 1 12 0v6" />
      <path d="M5 16h14" />
      <path d="M10 19a2 2 0 0 0 4 0" />
    </Icon>
  );
}

export function IconEmail() {
  return (
    <Icon>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M4 7l8 6 8-6" />
    </Icon>
  );
}

export function IconAdmin() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2" />
      <path d="M12 19v2" />
      <path d="M3 12h2" />
      <path d="M19 12h2" />
      <path d="M5.6 5.6l1.5 1.5" />
      <path d="M16.9 16.9l1.5 1.5" />
      <path d="M18.4 5.6l-1.5 1.5" />
      <path d="M7.1 16.9l-1.5 1.5" />
    </Icon>
  );
}
