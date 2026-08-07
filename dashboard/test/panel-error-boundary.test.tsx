import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelBody, PanelErrorBoundary } from '../src/panel-error-boundary';

const PANEL_NAMES = [
  'Reconciliation',
  'Treasuries',
  'Session',
  'Service readiness',
  'Managed wallets',
  'Projects',
  'Environments',
  'Funding policy',
  'Funding history',
] as const;

const PANEL_SEVERITY: Record<(typeof PANEL_NAMES)[number], 'alarm' | 'elevated' | 'quiet'> = {
  Reconciliation: 'alarm',
  Treasuries: 'alarm',
  Session: 'elevated',
  'Service readiness': 'elevated',
  'Managed wallets': 'elevated',
  Projects: 'quiet',
  Environments: 'quiet',
  'Funding policy': 'quiet',
  'Funding history': 'quiet',
};

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function HealthyPanel(props: { readonly name: (typeof PANEL_NAMES)[number] }) {
  return (
    <PanelErrorBoundary panelName={props.name} severity={PANEL_SEVERITY[props.name]}>
      <PanelBody
        render={() => (
          <section data-testid={`panel-${props.name}`}>
            <h2>{props.name}</h2>
          </section>
        )}
      />
    </PanelErrorBoundary>
  );
}

describe('PanelErrorBoundary / PanelBody', () => {
  it('isolates a throw inside PanelBody so sibling panels still render', () => {
    render(
      <>
        {PANEL_NAMES.map((name) =>
          name === 'Reconciliation' ? (
            <PanelErrorBoundary key={name} panelName={name} severity="alarm">
              <PanelBody
                render={() => {
                  throw new Error('recon boom');
                }}
              />
            </PanelErrorBoundary>
          ) : (
            <HealthyPanel key={name} name={name} />
          ),
        )}
      </>,
    );

    expect(screen.getByRole('alert').textContent).toContain('Reconciliation findings could not be rendered');
    expect(screen.getByText('recon boom')).toBeTruthy();

    for (const name of PANEL_NAMES) {
      if (name === 'Reconciliation') {
        expect(screen.queryByTestId(`panel-${name}`)).toBeNull();
      } else {
        expect(screen.getByTestId(`panel-${name}`)).toBeTruthy();
      }
    }
  });

  it('does not catch an eagerly evaluated throw; the root backstop shows and no panels remain', () => {
    function BrokenShell() {
      return (
        <>
          <PanelErrorBoundary panelName="Reconciliation" severity="alarm">
            {/* Evaluated during BrokenShell render — escapes the panel boundary (C22). */}
            {(() => {
              throw new Error('eager boom');
            })()}
          </PanelErrorBoundary>
          {PANEL_NAMES.filter((name) => name !== 'Reconciliation').map((name) => (
            <HealthyPanel key={name} name={name} />
          ))}
        </>
      );
    }

    render(
      <PanelErrorBoundary panelName="Root" severity="quiet" isRoot>
        <BrokenShell />
      </PanelErrorBoundary>,
    );

    const root = document.querySelector('.panel-failure-root');
    expect(root).toBeTruthy();
    expect(root?.className).toContain('panel-failure-alarm');
    expect(screen.getByRole('alert').textContent).toContain('Operator console failed');
    expect(screen.getByText('eager boom')).toBeTruthy();

    for (const name of PANEL_NAMES) {
      expect(screen.queryByTestId(`panel-${name}`)).toBeNull();
    }
  });

  it('maps alarm and elevated to assertive alert; quiet to polite status', () => {
    render(
      <PanelErrorBoundary panelName="Reconciliation" severity="alarm">
        <PanelBody
          render={() => {
            throw new Error('alarm');
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');

    cleanup();
    render(
      <PanelErrorBoundary panelName="Session" severity="elevated">
        <PanelBody
          render={() => {
            throw new Error('elevated');
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByRole('alert').getAttribute('aria-live')).toBe('assertive');

    cleanup();
    render(
      <PanelErrorBoundary panelName="Projects" severity="quiet">
        <PanelBody
          render={() => {
            throw new Error('quiet');
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByRole('status').getAttribute('aria-live')).toBe('polite');
  });

  it('forces alarm severity and root copy when isRoot', () => {
    render(
      <PanelErrorBoundary panelName="Root" severity="quiet" isRoot>
        <PanelBody
          render={() => {
            throw new Error('root fail');
          }}
        />
      </PanelErrorBoundary>,
    );

    const root = document.querySelector('.panel-failure-root');
    expect(root).toBeTruthy();
    expect(root?.className).toContain('panel-failure-alarm');
    expect(screen.getByRole('alert').textContent).toContain('Operator console failed');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('uses named-panel alarm copy for Reconciliation and Treasuries', () => {
    render(
      <PanelErrorBoundary panelName="Reconciliation" severity="alarm">
        <PanelBody
          render={() => {
            throw new Error('x');
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain('Reconciliation findings could not be rendered');
    expect(screen.getByRole('alert').textContent).toContain('Unacknowledged critical findings may exist');

    cleanup();
    render(
      <PanelErrorBoundary panelName="Treasuries" severity="alarm">
        <PanelBody
          render={() => {
            throw new Error('y');
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Treasury balance and reserve state could not be rendered',
    );
    expect(screen.getByRole('alert').textContent).not.toContain(
      'This panel carries operational security signal',
    );
  });

  it('surfaces Error.message and still renders for a non-Error throw', () => {
    render(
      <PanelErrorBoundary panelName="Projects" severity="quiet">
        <PanelBody
          render={() => {
            throw new Error('typed failure');
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByText('typed failure')).toBeTruthy();

    cleanup();
    render(
      <PanelErrorBoundary panelName="Projects" severity="quiet">
        <PanelBody
          render={() => {
            // Production boundaries accept unknown via getDerivedStateFromError.
            const nonError: unknown = 'string failure';
            throw nonError;
          }}
        />
      </PanelErrorBoundary>,
    );
    expect(screen.getByRole('status')).toBeTruthy();
    expect(screen.getByText('string failure')).toBeTruthy();
  });
});
