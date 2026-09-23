import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ManagedWalletResource } from '../src/api';
import { ALL_CHAINS, type VisibleChainIds } from '../src/chain-filter';
import { FundingPolicyPanel, type FundingPolicyPanelProps } from '../src/pages/panels/funding-policy-panel';

const SEPOLIA = 11_155_111;
const BASE = 84_532;
const SEPOLIA_ENABLED = '0x1111111111111111111111111111111111111111';
const SEPOLIA_DISABLED = '0x2222222222222222222222222222222222222222';
const BASE_ENABLED = '0x3333333333333333333333333333333333333333';
const BASE_DISABLED = '0x4444444444444444444444444444444444444444';

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe('funding policy chain filter (TX.41)', () => {
  it('shows only Base Sepolia policies, including disabled ones, and no Sepolia address or chain label', () => {
    render(<FundingPolicyPanel {...panelProps(sampleWallets(), [BASE])} />);

    expect(screen.getByRole('link', { name: BASE_ENABLED })).toBeTruthy();
    expect(screen.queryByRole('link', { name: SEPOLIA_ENABLED })).toBeNull();
    expect(screen.queryByText(SEPOLIA_ENABLED)).toBeNull();
    expect(screen.queryByText(SEPOLIA_DISABLED)).toBeNull();
    expect(screen.queryByText(/Ethereum Sepolia/)).toBeNull();
    expect(screen.queryByText(/Base Sepolia/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Disabled wallet policies (1)' }));

    expect(screen.getByRole('link', { name: BASE_DISABLED })).toBeTruthy();
    expect(screen.queryByRole('link', { name: SEPOLIA_DISABLED })).toBeNull();
    expect(screen.queryByText(/Ethereum Sepolia/)).toBeNull();
    expect(screen.queryByText(/Base Sepolia/)).toBeNull();
  });

  it('shows every policy card, including disabled ones, when the filter is ALL', () => {
    render(<FundingPolicyPanel {...panelProps(sampleWallets(), ALL_CHAINS)} />);

    expect(screen.getByRole('link', { name: SEPOLIA_ENABLED })).toBeTruthy();
    expect(screen.getByRole('link', { name: BASE_ENABLED })).toBeTruthy();
    expect(screen.getByText(/Ethereum Sepolia/)).toBeTruthy();
    expect(screen.getByText(/Base Sepolia/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Disabled wallet policies (2)' }));

    expect(screen.getByRole('link', { name: SEPOLIA_DISABLED })).toBeTruthy();
    expect(screen.getByRole('link', { name: BASE_DISABLED })).toBeTruthy();
  });

  it('says the selected chain has no policies, distinct from an empty policy response', () => {
    render(<FundingPolicyPanel {...panelProps(sampleWallets(), [1])} />);

    expect(screen.getByText('No funding policies on this chain.')).toBeTruthy();
    expect(screen.queryByText(/No wallets returned/)).toBeNull();
    expect(screen.queryByRole('link', { name: SEPOLIA_ENABLED })).toBeNull();
    expect(screen.queryByRole('link', { name: BASE_ENABLED })).toBeNull();
    expect(screen.queryByRole('button', { name: /Disabled wallet policies/ })).toBeNull();
  });
});

function panelProps(
  policyWallets: readonly ManagedWalletResource[],
  visibleChainIds: VisibleChainIds,
): FundingPolicyPanelProps {
  return {
    loadPolicyPanel: () => Promise.resolve(),
    selectedProjectId: '',
    policyState: 'ready',
    policyError: undefined,
    policyWalletsTotal: policyWallets.length,
    policyWallets,
    editingWalletId: undefined,
    beginEditPolicy: () => undefined,
    minimumEtherInput: '',
    setMinimumEtherInput: () => undefined,
    targetEtherInput: '',
    setTargetEtherInput: () => undefined,
    maximumEtherInput: '',
    setMaximumEtherInput: () => undefined,
    policyPreview: undefined,
    policyPreviewError: undefined,
    policyBusyId: undefined,
    onSavePolicy: () => Promise.resolve(),
    setEditingWalletId: () => undefined,
    setPolicyPreviewError: () => undefined,
    visibleChainIds,
  };
}

function sampleWallets(): readonly ManagedWalletResource[] {
  return [
    wallet({
      id: 'wallet-sepolia-admin',
      role: 'admin',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      address: SEPOLIA_ENABLED,
      enabled: true,
    }),
    wallet({
      id: 'wallet-sepolia-batcher',
      role: 'batcher',
      chainId: SEPOLIA,
      displayName: 'Ethereum Sepolia',
      address: SEPOLIA_DISABLED,
      enabled: false,
    }),
    wallet({
      id: 'wallet-base-proposer',
      role: 'proposer',
      chainId: BASE,
      displayName: 'Base Sepolia',
      address: BASE_ENABLED,
      enabled: true,
    }),
    wallet({
      id: 'wallet-base-probe',
      role: 'tx40-base-probe',
      chainId: BASE,
      displayName: 'Base Sepolia',
      address: BASE_DISABLED,
      enabled: false,
    }),
  ];
}

function wallet(input: {
  readonly id: string;
  readonly role: string;
  readonly chainId: number;
  readonly displayName: string;
  readonly address: string;
  readonly enabled: boolean;
}): ManagedWalletResource {
  return {
    id: input.id,
    project: { id: 'project-1', slug: 'fortel2', name: 'Fortel2', enabled: true },
    environment: { id: 'env-1', slug: 'development', name: 'Development', enabled: true },
    chain: {
      slug: input.chainId === BASE ? 'base-sepolia' : 'ethereum-sepolia',
      chainId: input.chainId,
      displayName: input.displayName,
      nativeSymbol: 'ETH',
    },
    role: input.role,
    address: input.address,
    explorerUrl: `https://example.test/address/${input.address}`,
    enabled: input.enabled,
    criticalAtStartup: false,
    reconciliationEnabled: true,
    policy: {
      minimumBalanceWei: '1000000000000000',
      targetBalanceWei: '2000000000000000',
      maximumTopUpWei: '2000000000000000',
      version: 1,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
  };
}
