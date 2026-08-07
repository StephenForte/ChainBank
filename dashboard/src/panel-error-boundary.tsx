import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * How loud a failed panel must read. Security-signal panels use `alarm` so a
 * calm grey box cannot replace an unacknowledged critical or missing reserve
 * posture (TX.15–TX.22). LoadState error paths (`error-inline`) are unrelated
 * — this boundary catches render throws only.
 */
export type PanelFailureSeverity = 'alarm' | 'elevated' | 'quiet';

export type PanelErrorBoundaryProps = {
  readonly panelName: string;
  readonly severity: PanelFailureSeverity;
  readonly children: ReactNode;
  /** Full-page backstop for throws outside any panel (or inside a panel fallback). */
  readonly isRoot?: boolean;
};

type PanelErrorBoundaryState = {
  readonly hasError: boolean;
  readonly errorMessage: string | undefined;
};

/** StrictMode can invoke componentDidCatch twice for the same thrown value. */
const reportedErrors = new WeakSet<object>();

function reportPanelRenderError(panelName: string, error: unknown, info: ErrorInfo): void {
  if (typeof error === 'object' && error !== null) {
    if (reportedErrors.has(error)) {
      return;
    }
    reportedErrors.add(error);
  }
  // C22: a caught render defect must be diagnosable in the browser console.
  // eslint-disable-next-line no-console -- intentional operator-facing diagnostics
  console.error(`[ChainBank] Panel "${panelName}" failed to render`, error, info.componentStack ?? '');
}

function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return String(error);
}

function fallbackCopy(
  panelName: string,
  severity: PanelFailureSeverity,
  isRoot: boolean,
): { readonly title: string; readonly body: string } {
  if (isRoot) {
    return {
      title: 'Operator console failed',
      body:
        'The console could not finish rendering. Unacknowledged critical findings and treasury ' +
        'state may exist and are not being shown. Open the browser console for the error, then ' +
        'reload the page. If the failure persists, inspect alerts and reconciliation runs via ' +
        'the API or SQL.',
    };
  }

  if (severity === 'alarm') {
    if (panelName === 'Reconciliation') {
      return {
        title: 'Reconciliation findings could not be rendered',
        body:
          'Unacknowledged critical findings may exist and are not being shown. This is a console ' +
          'defect, not a quiet empty state. Open the browser console for the error detail, reload ' +
          'the page, and if it persists inspect reconciliation runs and alerts via the API or SQL.',
      };
    }
    if (panelName === 'Treasuries') {
      return {
        title: 'Treasury balance and reserve state could not be rendered',
        body:
          'Spendable balance and reserve posture are not visible. Open the browser console for ' +
          'the error detail, then reload the page. If the failure persists, check treasuries via ' +
          'the API or SQL.',
      };
    }
    return {
      title: `${panelName} could not be rendered`,
      body:
        'This panel carries operational security signal that is not being shown. Open the ' +
        'browser console for the error detail, then reload the page.',
    };
  }

  if (severity === 'elevated') {
    if (panelName === 'Session') {
      return {
        title: 'Session controls could not be rendered',
        body:
          'The operator token was not cleared. Reload the page to recover. Open the browser ' +
          'console for the error detail.',
      };
    }
    if (panelName === 'Service readiness') {
      return {
        title: 'Service readiness could not be rendered',
        body:
          'Funding-gate and dependency status are not visible. Open the browser console for the ' +
          'error detail, then reload the page.',
      };
    }
    if (panelName === 'Managed wallets') {
      return {
        title: 'Managed wallets could not be rendered',
        body:
          'Wallet list and live balances are not visible. Open the browser console for the error ' +
          'detail, then reload the page.',
      };
    }
    return {
      title: `${panelName} could not be rendered`,
      body: 'Open the browser console for the error detail, then reload the page.',
    };
  }

  return {
    title: `${panelName} unavailable`,
    body: 'This panel failed to render. See the browser console for details, then reload if needed.',
  };
}

/**
 * Defers panel JSX until this child renders. Required because `App` is a single
 * function component: expressions in its return run during `App` render, which
 * a wrapping boundary cannot catch. `render` is invoked here — as a descendant
 * of `PanelErrorBoundary` — so a throw isolates to that panel.
 */
export function PanelBody(props: { readonly render: () => ReactNode }): ReactNode {
  return props.render();
}

/**
 * Isolates a render failure to one panel (or the root backstop). Does not catch
 * event-handler, effect, or promise failures — those keep their LoadState paths.
 * Children must be a component (typically `PanelBody`), not eagerly evaluated JSX.
 */
export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  public override state: PanelErrorBoundaryState = {
    hasError: false,
    errorMessage: undefined,
  };

  public static getDerivedStateFromError(error: unknown): PanelErrorBoundaryState {
    return {
      hasError: true,
      errorMessage: errorMessageOf(error),
    };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    reportPanelRenderError(this.props.panelName, error, info);
  }

  public override render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    const isRoot = this.props.isRoot === true;
    const copy = fallbackCopy(this.props.panelName, this.props.severity, isRoot);
    const severity = isRoot ? 'alarm' : this.props.severity;
    const className = isRoot
      ? `panel-failure panel-failure-root panel-failure-${severity}`
      : `panel panel-failure panel-failure-${severity}`;

    return (
      <section
        className={className}
        role={severity === 'quiet' ? 'status' : 'alert'}
        aria-live={severity === 'quiet' ? 'polite' : 'assertive'}
      >
        <h2 className="section-title">{copy.title}</h2>
        <p className="panel-failure-body">{copy.body}</p>
        {this.state.errorMessage !== undefined ? (
          <p className="panel-failure-meta muted mono">{this.state.errorMessage}</p>
        ) : null}
      </section>
    );
  }
}
