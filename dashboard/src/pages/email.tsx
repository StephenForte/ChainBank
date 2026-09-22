import { useState } from 'react';
import {
  EMAIL_DELIVERY_KIND_FILTERS,
  sendTestEmail,
  type EmailDeliveryResource,
  type EmailDeliveryStatus,
  type EmailTriggersResource,
} from '../api';
import { CollapsibleSection } from '../collapsible-section';
import { formatError, formatTimestamp, formatWeiAsEther, type LoadState } from '../dashboard-shared';
import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { DataTable } from '../primitives';
import { useHasPermission } from '../session/permissions';

const EMPTY_LOG = 'No emails have been sent yet';
const EMPTY_FILTERED = 'No deliveries match these filters';

export type EmailPageProps = {
  readonly triggersState: LoadState;
  readonly triggersError: string | undefined;
  readonly triggers: EmailTriggersResource | undefined;
  readonly deliveriesState: LoadState;
  readonly deliveriesError: string | undefined;
  readonly deliveries: readonly EmailDeliveryResource[];
  readonly deliveriesTotal: number;
  readonly deliveriesLimit: number;
  readonly deliveriesOffset: number;
  readonly statusFilter: '' | EmailDeliveryStatus;
  readonly kindFilter: string;
  readonly onStatusFilter: (value: '' | EmailDeliveryStatus) => void;
  readonly onKindFilter: (value: string) => void;
  readonly onPreviousPage: () => void;
  readonly onNextPage: () => void;
  readonly onDeliveriesReload: () => Promise<void>;
};

/**
 * `#/email` ignores the chain filter (C34). Do not read `visibleChainIds` here.
 */
export function EmailPage(props: EmailPageProps) {
  return (
    <>
      <PanelErrorBoundary panelName="Email triggers" severity="quiet">
        <PanelBody
          render={() => (
            <TriggersSection
              state={props.triggersState}
              error={props.triggersError}
              triggers={props.triggers}
            />
          )}
        />
      </PanelErrorBoundary>
      <PanelErrorBoundary panelName="Email deliveries" severity="quiet">
        <PanelBody render={() => <DeliveryLog {...props} />} />
      </PanelErrorBoundary>
    </>
  );
}

function TriggersSection(props: {
  readonly state: LoadState;
  readonly error: string | undefined;
  readonly triggers: EmailTriggersResource | undefined;
}) {
  const description = props.triggers;
  return (
    <section className="panel">
      <h2 className="section-title">Triggers</h2>
      {props.state === 'loading' || props.state === 'idle' ? <p className="muted">Loading…</p> : null}
      {props.state === 'error' ? <p className="error-inline">{props.error}</p> : null}
      {props.state === 'empty' ? <p className="muted">No triggers returned.</p> : null}
      {props.state === 'ready' && description !== undefined ? (
        <>
          <p className="email-summary">
            Sends from {description.fromAddress} via {description.provider} to{' '}
            {description.recipients.join(', ')}
          </p>
          <DataTable caption="Email triggers">
            <thead>
              <tr>
                <th>Trigger</th>
                <th>Scope</th>
                <th>Condition</th>
                <th>Recipients</th>
              </tr>
            </thead>
            <tbody>
              {description.triggers.map((row, index) => (
                <tr key={`${row.trigger}:${row.scope}:${String(index)}`}>
                  <td>{row.trigger}</td>
                  <td>{row.scope}</td>
                  <td>{formatTriggerCondition(row.condition)}</td>
                  <td className="email-recipients">{row.recipients.join(', ')}</td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}
    </section>
  );
}

/**
 * C35 writes threshold amounts as integer wei. Show them the way the treasury
 * cards do: full `formatWeiAsEther` precision, never a rounded ETH number.
 */
export function formatTriggerCondition(condition: string): string {
  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of condition.matchAll(/(\d+) wei/g)) {
    const index = match.index;
    const wei = match[1];
    if (index === undefined || wei === undefined) {
      continue;
    }
    parts.push(condition.slice(lastIndex, index));
    parts.push(`${formatWeiAsEther(wei)} ETH`);
    lastIndex = index + match[0].length;
  }
  parts.push(condition.slice(lastIndex));
  return parts.join('');
}

function deliveryStatusClass(status: EmailDeliveryStatus): string {
  return status === 'sent' ? 'badge badge-ok' : 'badge badge-bad';
}

function DeliveryLog(props: EmailPageProps) {
  const canSendTest = useHasPermission('email:test');
  const [sendState, setSendState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [sendError, setSendError] = useState<string | undefined>();
  const atStart = props.deliveriesOffset === 0;
  const atEnd = props.deliveriesOffset + props.deliveriesLimit >= props.deliveriesTotal;
  const pageBusy = props.deliveriesState === 'loading';

  async function onSendTestEmail(): Promise<void> {
    setSendState('sending');
    setSendError(undefined);
    try {
      await sendTestEmail();
      setSendState('sent');
      await props.onDeliveriesReload();
    } catch (caught) {
      setSendState('error');
      setSendError(formatError(caught));
    }
  }

  return (
    <section className="panel delivery-log">
      <h2 className="section-title">Delivery log</h2>
      {canSendTest ? (
        <div className="email-send">
          <button
            type="button"
            className="secondary"
            disabled={sendState === 'sending'}
            onClick={() => {
              void onSendTestEmail();
            }}
          >
            Send test email
          </button>
          {sendState === 'sent' ? (
            <p className="hint">
              Test email requested. Check the operator inbox (or server logs if provider is log-only).
            </p>
          ) : null}
          {sendState === 'error' ? <p className="error-inline">{sendError}</p> : null}
        </div>
      ) : null}
      <div className="filters row">
        <label htmlFor="email-status">Status</label>
        <select
          id="email-status"
          name="email-status"
          value={props.statusFilter}
          onChange={(event) => {
            const value = event.target.value;
            if (value === '' || value === 'sent' || value === 'failed') {
              props.onStatusFilter(value);
            }
          }}
        >
          <option value="">All</option>
          <option value="sent">sent</option>
          <option value="failed">failed</option>
        </select>
        <label htmlFor="email-kind">Kind</label>
        <select
          id="email-kind"
          name="email-kind"
          value={props.kindFilter}
          onChange={(event) => {
            props.onKindFilter(event.target.value);
          }}
        >
          <option value="">All</option>
          {EMAIL_DELIVERY_KIND_FILTERS.map((kind) => (
            <option key={kind} value={kind}>
              {kind}
            </option>
          ))}
        </select>
      </div>
      {props.deliveriesState === 'loading' || props.deliveriesState === 'idle' ? (
        <p className="muted">Loading…</p>
      ) : null}
      {props.deliveriesState === 'error' ? <p className="error-inline">{props.deliveriesError}</p> : null}
      {props.deliveriesState === 'empty' && props.deliveriesTotal === 0 ? (
        <p className="muted">{EMPTY_LOG}</p>
      ) : null}
      {props.deliveriesState === 'empty' && props.deliveriesTotal > 0 ? (
        <p className="muted">{EMPTY_FILTERED}</p>
      ) : null}
      {props.deliveriesState === 'ready' && props.deliveries.length > 0 ? (
        <>
          <p className="muted">
            Showing {String(props.deliveriesOffset + 1)}–
            {String(props.deliveriesOffset + props.deliveries.length)} of {String(props.deliveriesTotal)}{' '}
            deliveries (newest first).
          </p>
          <DataTable caption="Email deliveries">
            <thead>
              <tr>
                <th>
                  <span className="visually-hidden">Detail</span>
                </th>
                <th>Sent at</th>
                <th>Kind</th>
                <th>Subject</th>
                <th>Recipients</th>
                <th>Status</th>
                <th>Service role</th>
              </tr>
            </thead>
            <tbody>
              {props.deliveries.map((row) => (
                <tr key={row.id}>
                  <td colSpan={7}>
                    <div className="delivery-summary">
                      <CollapsibleSection title="Details">
                        <DeliveryDetail row={row} />
                      </CollapsibleSection>
                      <span className="email-when">{formatTimestamp(row.sentAt)}</span>
                      <span>{row.kind}</span>
                      <span>{row.subject}</span>
                      <span className="email-recipients">{row.recipients.join(', ')}</span>
                      <span>
                        <span className={deliveryStatusClass(row.status)}>{row.status}</span>
                      </span>
                      <span>{row.serviceRole}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </DataTable>
        </>
      ) : null}
      {props.deliveriesTotal > 0 &&
      props.deliveriesState !== 'loading' &&
      props.deliveriesState !== 'idle' ? (
        <div className="row email-pager">
          <button
            type="button"
            className="secondary"
            disabled={pageBusy || atStart}
            onClick={props.onPreviousPage}
          >
            Previous
          </button>
          <button type="button" className="secondary" disabled={pageBusy || atEnd} onClick={props.onNextPage}>
            Next
          </button>
        </div>
      ) : null}
    </section>
  );
}

function blank(value: string | null): string {
  if (value === null || value === '') {
    return '—';
  }
  return value;
}

function DeliveryDetail(props: { readonly row: EmailDeliveryResource }) {
  const row = props.row;
  const related =
    row.relatedEntityType === null && row.relatedEntityId === null
      ? '—'
      : `${blank(row.relatedEntityType)} ${blank(row.relatedEntityId)}`;
  return (
    <dl className="delivery-detail">
      <dt>Provider message id</dt>
      <dd>{blank(row.providerMessageId)}</dd>
      <dt>Error code</dt>
      <dd>{blank(row.errorCode)}</dd>
      <dt>Error summary</dt>
      <dd>{blank(row.errorSummary)}</dd>
      <dt>Related entity</dt>
      <dd>{related}</dd>
      <dt>Correlation id</dt>
      <dd>{blank(row.correlationId)}</dd>
    </dl>
  );
}
