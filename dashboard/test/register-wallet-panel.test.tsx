import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAddress } from 'viem';
import type { EnvironmentResource, ProjectResource } from '../src/api';
import { SESSION_HEADER_NAME, SESSION_HEADER_VALUE } from '../src/api';
import type { ChainSegment } from '../src/chain-filter';
import {
  RegisterWalletPanel,
  type RegisterWalletPanelProps,
  type RegisteredWallet,
} from '../src/pages/panels/register-wallet-panel';
import { PermissionsProvider } from '../src/session/permissions';

const PROJECT_A = '11111111-1111-4111-8111-111111111111';
const PROJECT_B = '22222222-2222-4222-8222-222222222222';
const ENV_A = '33333333-3333-4333-8333-333333333333';
const ENV_B = '44444444-4444-4444-8444-444444444444';
const LOWER_ADDRESS = '0x0c4667ef97b39599b9aca980d3b6465ce6cf2568';
const CHECKSUMMED_ADDRESS = getAddress(LOWER_ADDRESS);
const BAD_CHECKSUM = '0x0c4667EF97B39599B9AcA980D3b6465Ce6cF2568';
const DUPLICATE_MESSAGE = 'A managed wallet with this chain and address is already registered.';

const VIEWER_PERMISSIONS = ['wallet:read', 'project:read'] as const;

const CHAINS: readonly ChainSegment[] = [
  { chainId: 11_155_111, displayName: 'Ethereum Sepolia' },
  { chainId: 84_532, displayName: 'Base Sepolia' },
];

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('register wallet panel (TX.42)', () => {
  it('shows a viewer no register form or button', () => {
    render(
      <Harness permissions={VIEWER_PERMISSIONS}>
        <ConnectedPanel onRegistered={() => undefined} />
      </Harness>,
    );

    expect(screen.queryByRole('heading', { name: 'Register a wallet' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review registration' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Register wallet' })).toBeNull();
    expect(screen.queryByLabelText('Address')).toBeNull();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('rejects a wrong-length address and a non-hex address before submit', () => {
    const fetchMock = installFetch(() => {
      throw new Error('fetch should not run');
    });
    render(
      <Harness permissions={['wallet:write']}>
        <ConnectedPanel onRegistered={() => undefined} />
      </Harness>,
    );

    fillIdentity();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: '0x1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review registration' }));

    expect(screen.getByText(/0x followed by 40 hex digits/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Confirm registration' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Address'), {
      target: { value: `0x${'g'.repeat(40)}` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Review registration' }));

    expect(screen.getByText(/0x followed by 40 hex digits/)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a mixed-case address with a bad checksum before submit', () => {
    const fetchMock = installFetch(() => {
      throw new Error('fetch should not run');
    });
    render(
      <Harness permissions={['wallet:write']}>
        <ConnectedPanel onRegistered={() => undefined} />
      </Harness>,
    );

    fillIdentity();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: BAD_CHECKSUM } });
    fireEvent.click(screen.getByRole('button', { name: 'Review registration' }));

    expect(screen.getByText(/invalid checksum/)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Confirm registration' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('confirms the checksummed address and chain, then posts that body and reloads', async () => {
    const onRegistered = vi.fn<(registered: RegisteredWallet) => void>();
    const fetchMock = installFetch(() => jsonResponse(200, { data: { id: 'wallet-new' } }));
    render(
      <Harness permissions={['wallet:write']}>
        <ConnectedPanel onRegistered={onRegistered} />
      </Harness>,
    );

    fillIdentity();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: LOWER_ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: 'Review registration' }));

    const confirm = screen.getByRole('region', { name: 'Confirm registration' });
    expect(confirm.textContent).toContain('Base Sepolia');
    expect(confirm.textContent).toContain('84532');
    expect(confirm.textContent).toContain(CHECKSUMMED_ADDRESS);
    expect(confirm.textContent).toContain('fortel2');
    expect(confirm.textContent).toContain('development');
    expect(confirm.textContent).toContain('batcher');
    expect(confirm.textContent).not.toContain(LOWER_ADDRESS);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /reconcile/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Register wallet' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(requestUrl(input)).toBe('/v1/wallets');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get(SESSION_HEADER_NAME)).toBe(SESSION_HEADER_VALUE);
    expect(headers.get('Authorization')).toBeNull();
    const rawBody = init?.body;
    if (typeof rawBody !== 'string') {
      throw new Error('expected a JSON string body');
    }
    const parsed: unknown = JSON.parse(rawBody);
    expect(parsed).toEqual({
      projectId: PROJECT_A,
      environmentId: ENV_A,
      chainId: 84_532,
      role: 'batcher',
      address: CHECKSUMMED_ADDRESS,
    });

    await waitFor(() => {
      expect(onRegistered).toHaveBeenCalledTimes(1);
    });
    expect(onRegistered).toHaveBeenCalledWith({
      projectId: PROJECT_A,
      environmentId: ENV_A,
      chainId: 84_532,
      role: 'batcher',
      address: CHECKSUMMED_ADDRESS,
    });
  });

  it('offers only the registered chains it was given', () => {
    render(
      <Harness permissions={['wallet:write']}>
        <ConnectedPanel onRegistered={() => undefined} />
      </Harness>,
    );

    const chain = screen.getByLabelText('Chain');
    expect(chain.tagName).toBe('SELECT');
    expect(screen.queryByRole('textbox', { name: 'Chain' })).toBeNull();
    expect(optionValues(chain)).toEqual(['', '11155111', '84532']);
    expect(optionLabels(chain)).toEqual([
      'Choose a chain',
      'Ethereum Sepolia (11155111)',
      'Base Sepolia (84532)',
    ]);
  });

  it("offers only the chosen project's environments", () => {
    render(
      <Harness permissions={['wallet:write']}>
        <ConnectedPanel onRegistered={() => undefined} />
      </Harness>,
    );

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: PROJECT_A } });
    expect(optionValues(screen.getByLabelText('Environment'))).toEqual(['', ENV_A]);

    fireEvent.change(screen.getByLabelText('Project'), { target: { value: PROJECT_B } });
    expect(optionValues(screen.getByLabelText('Environment'))).toEqual(['', ENV_B]);
    expect(optionLabels(screen.getByLabelText('Environment'))).toContain('staging');
    expect(optionLabels(screen.getByLabelText('Environment'))).not.toContain('development');
  });

  it('shows the duplicate public message and leaves the form filled', async () => {
    const onRegistered = vi.fn();
    installFetch(() =>
      jsonResponse(409, {
        error: {
          code: 'WALLET_ALREADY_REGISTERED',
          message: DUPLICATE_MESSAGE,
        },
        requestId: 'req-tx42',
      }),
    );
    render(
      <Harness permissions={['wallet:write']}>
        <ConnectedPanel onRegistered={onRegistered} />
      </Harness>,
    );

    fillIdentity();
    fireEvent.change(screen.getByLabelText('Address'), { target: { value: LOWER_ADDRESS } });
    fireEvent.click(screen.getByRole('button', { name: 'Review registration' }));
    fireEvent.click(screen.getByRole('button', { name: 'Register wallet' }));

    expect(await screen.findByText(new RegExp(DUPLICATE_MESSAGE))).toBeTruthy();
    expect(screen.getByText(/WALLET_ALREADY_REGISTERED/)).toBeTruthy();
    expect(screen.queryByText(/Managed wallet 0x/)).toBeNull();
    expect(inputValue('Address')).toBe(LOWER_ADDRESS);
    expect(inputValue('Role')).toBe('batcher');
    expect(inputValue('Project')).toBe(PROJECT_A);
    expect(inputValue('Environment')).toBe(ENV_A);
    expect(inputValue('Chain')).toBe('84532');
    expect(onRegistered).not.toHaveBeenCalled();
  });
});

function Harness(props: { readonly permissions: readonly string[]; readonly children: ReactNode }) {
  return <PermissionsProvider permissions={props.permissions}>{props.children}</PermissionsProvider>;
}

function ConnectedPanel(props: { readonly onRegistered: RegisterWalletPanelProps['onRegistered'] }) {
  const [projectId, setProjectId] = useState('');
  return (
    <RegisterWalletPanel
      projects={projects()}
      projectId={projectId}
      onProjectChange={setProjectId}
      environments={environments()}
      environmentsState="ready"
      environmentsError={undefined}
      chains={CHAINS}
      onRegistered={props.onRegistered}
    />
  );
}

function fillIdentity(): void {
  fireEvent.change(screen.getByLabelText('Project'), { target: { value: PROJECT_A } });
  fireEvent.change(screen.getByLabelText('Environment'), { target: { value: ENV_A } });
  fireEvent.change(screen.getByLabelText('Chain'), { target: { value: '84532' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'batcher' } });
}

function projects(): readonly ProjectResource[] {
  return [project(PROJECT_A, 'fortel2', 'Fortel2'), project(PROJECT_B, 'settlementos', 'SettlementOS')];
}

function project(id: string, slug: string, name: string): ProjectResource {
  return {
    id,
    slug,
    name,
    enabled: true,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
}

function environments(): readonly EnvironmentResource[] {
  return [
    environment(ENV_A, PROJECT_A, 'development', 'Development'),
    environment(ENV_B, PROJECT_B, 'staging', 'Staging'),
  ];
}

function environment(id: string, projectId: string, slug: string, name: string): EnvironmentResource {
  return {
    id,
    projectId,
    slug,
    name,
    enabled: true,
    createdAt: '2026-09-23T00:00:00.000Z',
    updatedAt: '2026-09-23T00:00:00.000Z',
  };
}

function optionValues(element: HTMLElement): string[] {
  return [...element.querySelectorAll('option')].map((option) => option.value);
}

function optionLabels(element: HTMLElement): string[] {
  return [...element.querySelectorAll('option')].map((option) => option.textContent ?? '');
}

function inputValue(label: string): string {
  const element = screen.getByLabelText(label);
  if (!(element instanceof HTMLInputElement) && !(element instanceof HTMLSelectElement)) {
    throw new Error(`${label} is not a field`);
  }
  return element.value;
}

function installFetch(
  respond: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
): ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>> {
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    return Promise.resolve(respond(requestUrl(input), init));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function requestUrl(input: RequestInfo | URL | undefined): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (input instanceof Request) {
    return input.url;
  }
  return '';
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
