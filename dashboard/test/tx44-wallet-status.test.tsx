import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedWalletResource } from '../src/api';
import {
  ManagedWalletsPanel,
  type ManagedWalletsPanelProps,
} from '../src/pages/panels/managed-wallets-panel';
import { PermissionsProvider } from '../src/session/permissions';

const NOT_AUTO_FUNDED = '0x1111111111111111111111111111111111111111';
const AUTO_FUNDED = '0x2222222222222222222222222222222222222222';
const DISABLED_RECONCILE_OFF = '0x3333333333333333333333333333333333333333';
const DISABLED_RECONCILE_ON = '0x4444444444444444444444444444444444444444';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('managed wallet auto-funding badge (TX.44)', () => {
  it('shows a warning badge when the wallet is enabled and reconcile is off', () => {
    renderPanel([
      wallet({
        id: 'wallet-not-funded',
        role: 'happy-meal',
        address: NOT_AUTO_FUNDED,
        enabled: true,
        reconciliationEnabled: false,
      }),
    ]);

    const row = rowFor('happy-meal');
    const badge = within(row).getByText('not auto-funded');
    expect(badge.className).toContain('badge-warn');
    expect(within(row).getByText('enabled').className).toContain('badge-ok');
    expect(within(row).queryByText('auto-funded')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Enable reconcile' })).toBeTruthy();
  });

  it('shows that the wallet is auto-funded when it is enabled and reconcile is on', () => {
    renderPanel([
      wallet({
        id: 'wallet-funded',
        role: 'batcher',
        address: AUTO_FUNDED,
        enabled: true,
        reconciliationEnabled: true,
      }),
    ]);

    const row = rowFor('batcher');
    const badge = within(row).getByText('auto-funded');
    expect(badge.className).toContain('badge-ok');
    expect(within(row).getByText('enabled')).toBeTruthy();
    expect(within(row).queryByText('not auto-funded')).toBeNull();
    expect(within(row).getByRole('button', { name: 'Disable reconcile' })).toBeTruthy();
  });

  it('keeps the disabled badge authoritative whether reconcile is on or off', () => {
    renderPanel(
      [
        wallet({
          id: 'wallet-disabled-off',
          role: 'probe-off',
          address: DISABLED_RECONCILE_OFF,
          enabled: false,
          reconciliationEnabled: false,
        }),
        wallet({
          id: 'wallet-disabled-on',
          role: 'probe-on',
          address: DISABLED_RECONCILE_ON,
          enabled: false,
          reconciliationEnabled: true,
        }),
      ],
      'false',
    );

    for (const role of ['probe-off', 'probe-on']) {
      const row = rowFor(role);
      const badge = within(row).getByText('disabled');
      expect(badge.className).toContain('badge-bad');
      expect(within(row).queryByText('not auto-funded')).toBeNull();
      expect(within(row).queryByText('auto-funded')).toBeNull();
    }
  });

  it('says not auto-funded when reconcile is on but the project or environment is disabled', () => {
    renderPanel([
      wallet({
        id: 'wallet-project-off',
        role: 'project-off',
        address: '0x5555555555555555555555555555555555555555',
        enabled: true,
        reconciliationEnabled: true,
        projectEnabled: false,
      }),
      wallet({
        id: 'wallet-env-off',
        role: 'env-off',
        address: '0x6666666666666666666666666666666666666666',
        enabled: true,
        reconciliationEnabled: true,
        environmentEnabled: false,
      }),
    ]);

    for (const [role, reason] of [
      ['project-off', 'Project is disabled'],
      ['env-off', 'Environment is disabled'],
    ] as const) {
      const row = rowFor(role);
      const badge = within(row).getByText('not auto-funded');
      expect(badge.className).toContain('badge-warn');
      expect(badge.getAttribute('title')).toBe(reason);
      expect(within(row).queryByText('auto-funded')).toBeNull();
    }
  });
});

function rowFor(role: string): HTMLElement {
  const cell = screen.getByText(role);
  const row = cell.closest('tr');
  if (row === null) {
    throw new Error(`no row for ${role}`);
  }
  return row;
}

function renderPanel(wallets: readonly ManagedWalletResource[], walletEnabledFilter = ''): void {
  const props: ManagedWalletsPanelProps = {
    checkListedWalletBalances: () => Promise.resolve(),
    loadWalletsPanel: () => Promise.resolve(),
    walletsState: 'ready',
    balancesBusy: false,
    walletProjectFilter: '',
    setWalletProjectFilter: () => undefined,
    walletEnvironmentFilter: '',
    setWalletEnvironmentFilter: () => undefined,
    walletEnabledFilter,
    setWalletEnabledFilter: () => undefined,
    selectedProjectId: '',
    walletsError: undefined,
    walletsTotal: wallets.length,
    wallets,
    walletBalances: {},
    fetchOneWalletBalance: () => Promise.resolve(),
    walletBusyId: undefined,
    onToggleWallet: () => Promise.resolve(),
    onToggleWalletReconciliation: () => Promise.resolve(),
  };
  render(
    <PermissionsProvider permissions={['wallet:write']}>
      <ManagedWalletsPanel {...props} />
    </PermissionsProvider>,
  );
}

function wallet(input: {
  readonly id: string;
  readonly role: string;
  readonly address: string;
  readonly enabled: boolean;
  readonly reconciliationEnabled: boolean;
  readonly projectEnabled?: boolean;
  readonly environmentEnabled?: boolean;
}): ManagedWalletResource {
  return {
    id: input.id,
    project: { id: 'project-1', slug: 'fortel2', name: 'Fortel2', enabled: input.projectEnabled ?? true },
    environment: {
      id: 'env-1',
      slug: 'development',
      name: 'Development',
      enabled: input.environmentEnabled ?? true,
    },
    chain: {
      slug: 'base-sepolia',
      chainId: 84_532,
      displayName: 'Base Sepolia',
      nativeSymbol: 'ETH',
    },
    role: input.role,
    address: input.address,
    explorerUrl: `https://sepolia.basescan.org/address/${input.address}`,
    enabled: input.enabled,
    criticalAtStartup: false,
    reconciliationEnabled: input.reconciliationEnabled,
    policy: {
      minimumBalanceWei: '1000000000000000',
      targetBalanceWei: '2000000000000000',
      maximumTopUpWei: '2000000000000000',
      version: 1,
      updatedAt: '2026-09-23T00:00:00.000Z',
    },
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
}
