import type { AlertResource, ReconciliationRunResource, TreasuryResource } from '../api';
import * as dash from '../dashboard-shared';
import type { FindingView, LoadState } from '../dashboard-shared';
import type { Dispatch, SetStateAction } from 'react';

export type ReconciliationPanelProps = {
  readonly loadReconciliationRuns: (activeToken: string) => Promise<void>;
  readonly loadFindingAlerts: (activeToken: string) => Promise<void>;
  readonly token: string;
  readonly findingAlertsState: LoadState;
  readonly findingAlertsError: string | undefined;
  readonly openFindingAlerts: readonly AlertResource[];
  readonly treasuries: readonly TreasuryResource[];
  readonly ackDraftByAlertId: Readonly<Record<string, string>>;
  readonly ackErrorByAlertId: Readonly<Record<string, string>>;
  readonly ackBusyId: string | undefined;
  readonly setAckDraftByAlertId: Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
  readonly onAcknowledgeFinding: (alertId: string) => Promise<void>;
  readonly acknowledgedFindingAlerts: readonly AlertResource[];
  readonly acknowledgedFindingsExpanded: boolean;
  readonly onToggleAcknowledgedFindings: () => void;
  readonly reconciliationState: LoadState;
  readonly reconciliationError: string | undefined;
  readonly reconciliationRunsTotal: number;
  readonly reconciliationRuns: readonly ReconciliationRunResource[];
  readonly openFindingAlertsComplete: boolean;
  readonly expandedCriticalEntityIds: Readonly<Record<string, boolean>>;
  readonly setExpandedCriticalEntityIds: Dispatch<SetStateAction<Readonly<Record<string, boolean>>>>;
  readonly ackDraftByEntityId: Readonly<Record<string, string>>;
  readonly setAckDraftByEntityId: Dispatch<SetStateAction<Readonly<Record<string, string>>>>;
  readonly ackErrorByEntityId: Readonly<Record<string, string>>;
  readonly ackBusyEntityId: string | undefined;
  readonly onAcknowledgeFindingByEntity: (finding: FindingView, entityId: string) => Promise<void>;
  readonly reconciliationDetailExpanded: boolean;
  readonly onToggleReconciliationDetail: () => void;
};

export function ReconciliationPanel({
  loadReconciliationRuns,
  loadFindingAlerts,
  token,
  findingAlertsState,
  findingAlertsError,
  openFindingAlerts,
  treasuries,
  ackDraftByAlertId,
  ackErrorByAlertId,
  ackBusyId,
  setAckDraftByAlertId,
  onAcknowledgeFinding,
  acknowledgedFindingAlerts,
  acknowledgedFindingsExpanded,
  onToggleAcknowledgedFindings,
  reconciliationState,
  reconciliationError,
  reconciliationRunsTotal,
  reconciliationRuns,
  openFindingAlertsComplete,
  expandedCriticalEntityIds,
  setExpandedCriticalEntityIds,
  ackDraftByEntityId,
  setAckDraftByEntityId,
  ackErrorByEntityId,
  ackBusyEntityId,
  onAcknowledgeFindingByEntity,
  reconciliationDetailExpanded,
  onToggleReconciliationDetail,
}) {
  return (
<section className="panel">
  <div className="panel-head">
    <h2 className="section-title">Reconciliation</h2>
    <button
      type="button"
      className="secondary"
      onClick={() => {
        void loadReconciliationRuns(token);
        void loadFindingAlerts(token);
      }}
    >
      Reload
    </button>
  </div>
  {token === '' ? (
    <p className="muted">Paste an operator token to load reconciliation runs.</p>
  ) : (
    <>
      {/*
  Standing banner from GET /v1/alerts — independent of the runs page
  window so an older critical finding cannot go invisible (C20 / TX.17).
*/}
      {findingAlertsState === 'loading' ? (
        <p className="muted">Loading finding alerts…</p>
      ) : null}
      {findingAlertsState === 'error' ? (
        <p className="error-inline">{findingAlertsError}</p>
      ) : null}
      {openFindingAlerts.length > 0 ? (
        <div className="finding-alert-banner" role="alert">
          <p className="finding-alert-banner-title">
            {openFindingAlerts.length === 1
              ? '1 unacknowledged critical finding'
              : `${String(openFindingAlerts.length)} unacknowledged critical findings`}
          </p>
          <p className="muted">
            These stay open until an operator records a note. Re-observation of the same
            transfer will not re-alert after acknowledgement.
          </p>
          <div className="finding-list recon-critical-always">
            {openFindingAlerts.map((alert) => {
              const meta = alert.metadata;
              const transactionHash = dash.asOptionalString(meta.transactionHash) ?? alert.entityId;
              const toAddress = dash.asOptionalString(meta.toAddress);
              const valueWei = dash.asOptionalString(meta.valueWei);
              const treasuryId = dash.asOptionalString(meta.treasuryId);
              const href = dash.explorerTxUrl(treasuries, treasuryId, transactionHash);
              const draft = ackDraftByAlertId[alert.id] ?? '';
              const ackError = ackErrorByAlertId[alert.id];
              return (
                <article key={alert.id} className="finding finding-critical">
                  <div className="finding-head">
                    <span className="badge badge-bad badge-square">unacknowledged</span>
                    <code>{dash.asOptionalString(meta.findingKind) ?? alert.alertType}</code>
                  </div>
                  <dl className="facts">
                    <div>
                      <dt>{dash.findingEntityLabel(transactionHash)}</dt>
                      <dd className="mono">
                        {href === undefined ? (
                          <span title={transactionHash}>{transactionHash}</span>
                        ) : (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer"
                            title={transactionHash}
                          >
                            {dash.shortAddress(transactionHash)}
                          </a>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Destination</dt>
                      <dd className="mono">
                        {toAddress === undefined ? '—' : dash.shortAddress(toAddress)}
                      </dd>
                    </div>
                    <div>
                      <dt>Value</dt>
                      <dd className="mono">
                        {valueWei === undefined ? '—' : dash.formatFindingWei(valueWei)}
                      </dd>
                    </div>
                    <div>
                      <dt>First seen</dt>
                      <dd>{dash.formatTimestamp(alert.firstTriggeredAt)}</dd>
                    </div>
                  </dl>
                  <label className="ack-note-label" htmlFor={`ack-note-${alert.id}`}>
                    Acknowledgement note (required)
                  </label>
                  <textarea
                    id={`ack-note-${alert.id}`}
                    className="ack-note"
                    rows={3}
                    value={draft}
                    disabled={ackBusyId === alert.id}
                    placeholder="Why this signal is stood down (e.g. confirmed operator hand-send)."
                    onChange={(event) => {
                      const value = event.target.value;
                      setAckDraftByAlertId((prev) => ({ ...prev, [alert.id]: value }));
                    }}
                  />
                  {ackError !== undefined ? <p className="error-inline">{ackError}</p> : null}
                  <button
                    type="button"
                    disabled={ackBusyId === alert.id}
                    onClick={() => void onAcknowledgeFinding(alert.id)}
                  >
                    {ackBusyId === alert.id ? 'Acknowledging…' : 'Acknowledge'}
                  </button>
                </article>
              );
            })}
          </div>
        </div>
      ) : null}
      {acknowledgedFindingAlerts.length > 0 ? (
        <div className="acknowledged-findings">
          <div className="acknowledged-findings-head">
            <button
              type="button"
              className="recon-toggle"
              aria-expanded={acknowledgedFindingsExpanded}
              aria-controls="acknowledged-findings-list"
              title={
                acknowledgedFindingsExpanded
                  ? 'Collapse acknowledged findings'
                  : 'Expand acknowledged findings'
              }
              onClick={onToggleAcknowledgedFindings}
            >
              {acknowledgedFindingsExpanded ? '−' : '+'}
            </button>
            <h3 className="subsection-title">
              {acknowledgedFindingAlerts.length === 1
                ? '1 acknowledged finding'
                : `${String(acknowledgedFindingAlerts.length)} acknowledged findings`}
            </h3>
          </div>
          {acknowledgedFindingsExpanded ? (
            <>
              <p className="muted">
                Acknowledged incidents stay visible with their note — there is no un-acknowledge
                path.
              </p>
              <div className="finding-list" id="acknowledged-findings-list">
                {acknowledgedFindingAlerts.map((alert) => {
                  const meta = alert.metadata;
                  const transactionHash =
                    dash.asOptionalString(meta.transactionHash) ?? alert.entityId;
                  const href = dash.explorerTxUrl(
                    treasuries,
                    dash.asOptionalString(meta.treasuryId),
                    transactionHash,
                  );
                  return (
                    <article key={alert.id} className="finding finding-acknowledged">
                      <div className="finding-head">
                        <span className="badge badge-ok badge-square">acknowledged</span>
                        <code>{dash.asOptionalString(meta.findingKind) ?? alert.alertType}</code>
                      </div>
                      <dl className="facts">
                        <div>
                          <dt>{dash.findingEntityLabel(transactionHash)}</dt>
                          <dd className="mono">
                            {href === undefined ? (
                              <span title={transactionHash}>{transactionHash}</span>
                            ) : (
                              <a
                                href={href}
                                target="_blank"
                                rel="noreferrer"
                                title={transactionHash}
                              >
                                {dash.shortAddress(transactionHash)}
                              </a>
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt>Acknowledged</dt>
                          <dd>
                            {alert.acknowledgedAt === null
                              ? '—'
                              : dash.formatTimestamp(alert.acknowledgedAt)}
                            {alert.acknowledgedBy !== null ? (
                              <span className="muted">
                                {' '}
                                · by{' '}
                                <code title={alert.acknowledgedBy}>
                                  {dash.shortAddress(alert.acknowledgedBy)}
                                </code>
                              </span>
                            ) : null}
                          </dd>
                        </div>
                      </dl>
                      {alert.acknowledgementNote !== null ? (
                        <p className="ack-note-display">{alert.acknowledgementNote}</p>
                      ) : null}
                    </article>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      ) : null}

      {reconciliationState === 'loading' ? <p className="muted">Loading…</p> : null}
      {reconciliationState === 'error' ? (
        <p className="error-inline">{reconciliationError}</p>
      ) : null}
      {reconciliationState === 'empty' ? (
        <p className="muted">
          No reconciliation runs returned ({String(reconciliationRunsTotal)} total).
        </p>
      ) : null}
      {reconciliationState === 'ready'
        ? (() => {
            const findings = dash.toFindingViews(reconciliationRuns);
            const criticalFindings = findings.filter((item) => item.severity === 'critical');
            const warningFindings = findings.filter((item) => item.severity === 'warning');
            const otherFindings = findings.filter(
              (item) => item.severity !== 'critical' && item.severity !== 'warning',
            );
            // Truncated open pages cannot prove open-absence — treat like unresolved for demotion/summary.
            const alertsResolvedForDemotion =
              dash.areFindingAlertsResolved(findingAlertsState) && openFindingAlertsComplete;
            const unacknowledgedCriticalFindings = criticalFindings.filter(
              (item) =>
                !dash.isCriticalFindingAcknowledged(
                  item,
                  findingAlertsState,
                  openFindingAlerts,
                  acknowledgedFindingAlerts,
                  openFindingAlertsComplete,
                ),
            );
            const acknowledgedCriticalFindings = criticalFindings.filter((item) =>
              dash.isCriticalFindingAcknowledged(
                item,
                findingAlertsState,
                openFindingAlerts,
                acknowledgedFindingAlerts,
                openFindingAlertsComplete,
              ),
            );
            const newestRun = reconciliationRuns[0];
            const hasUnacknowledgedCritical = unacknowledgedCriticalFindings.length > 0;
            const hasCritical = criticalFindings.length > 0;
            const summaryNeedsAttention = hasUnacknowledgedCritical || otherFindings.length > 0;
            const criticalLabel = dash.criticalFindingsSummaryLabel(
              unacknowledgedCriticalFindings.length,
              acknowledgedCriticalFindings.length,
              alertsResolvedForDemotion,
            );
            const renderCriticalFindingDetail = (
              finding: FindingView,
              entityId: string,
              href: string | undefined,
              acknowledgement: AlertResource | undefined,
            ) => (
              <>
                <dl className="facts">
                  <div>
                    <dt>{dash.findingEntityLabel(entityId)}</dt>
                    <dd className="mono">
                      {dash.TRANSACTION_HASH_PATTERN.test(entityId) ? (
                        href === undefined ? (
                          <span title={entityId}>{entityId}</span>
                        ) : (
                          <a href={href} target="_blank" rel="noreferrer" title={entityId}>
                            {dash.shortAddress(entityId)}
                          </a>
                        )
                      ) : (
                        <span title={entityId}>{entityId}</span>
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Destination</dt>
                    <dd className="mono">
                      {finding.toAddress === undefined ? '—' : dash.shortAddress(finding.toAddress)}
                    </dd>
                  </div>
                  <div>
                    <dt>Value</dt>
                    <dd className="mono">
                      {finding.valueWei === undefined
                        ? '—'
                        : dash.formatFindingWei(finding.valueWei)}
                    </dd>
                  </div>
                  <div>
                    <dt>Nonce</dt>
                    <dd className="mono">
                      {finding.nonce === undefined ? '—' : String(finding.nonce)}
                    </dd>
                  </div>
                  <div>
                    <dt>Block</dt>
                    <dd className="mono">{finding.blockNumber ?? '—'}</dd>
                  </div>
                  <div>
                    <dt>Run</dt>
                    <dd>
                      <code>{finding.runId}</code>
                      <span className="muted"> · {dash.formatTimestamp(finding.runStartedAt)}</span>
                    </dd>
                  </div>
                  {acknowledgement !== undefined ? (
                    <div>
                      <dt>Acknowledged</dt>
                      <dd>
                        {acknowledgement.acknowledgedAt === null
                          ? '—'
                          : dash.formatTimestamp(acknowledgement.acknowledgedAt)}
                        {acknowledgement.acknowledgedBy !== null ? (
                          <span className="muted">
                            {' '}
                            · by{' '}
                            <code title={acknowledgement.acknowledgedBy}>
                              {dash.shortAddress(acknowledgement.acknowledgedBy)}
                            </code>
                          </span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                {finding.reason !== undefined ? (
                  <p className="muted">{finding.reason}</p>
                ) : null}
                {acknowledgement?.acknowledgementNote !== null &&
                acknowledgement?.acknowledgementNote !== undefined ? (
                  <p className="ack-note-display">{acknowledgement.acknowledgementNote}</p>
                ) : null}
              </>
            );

            /**
             * Compact always-visible critical (TX.22 / C17): one dense row stays
             * visible with the panel collapsed. Expanding reveals the field grid;
             * collapsing never hides presence or summary count.
             */
            const renderUnacknowledgedCriticalFinding = (
              finding: FindingView,
              index: number,
            ) => {
              const entityKey =
                dash.findingAlertEntityId(finding) ??
                `${finding.runId}:${finding.kind}:${String(index)}`;
              const canAcknowledge = dash.findingAlertEntityId(finding) !== undefined;
              const href = dash.explorerTxUrl(
                treasuries,
                finding.treasuryId,
                finding.transactionHash,
              );
              const displayId =
                dash.findingAlertEntityId(finding) ?? finding.transactionHash ?? finding.kind;
              const isExpanded = expandedCriticalEntityIds[entityKey] === true;
              const draft = ackDraftByEntityId[entityKey] ?? '';
              const ackError = ackErrorByEntityId[entityKey];
              const isBusy = ackBusyEntityId === entityKey;
              return (
                <article
                  key={`critical-${finding.runId}-${finding.kind}-${String(index)}`}
                  className="finding finding-critical finding-critical-compact"
                >
                  <div className="finding-compact-row">
                    <button
                      type="button"
                      className="finding-expand-toggle"
                      aria-expanded={isExpanded}
                      title={isExpanded ? 'Hide finding detail' : 'Show finding detail'}
                      onClick={() => {
                        setExpandedCriticalEntityIds((prev) => ({
                          ...prev,
                          [entityKey]: !isExpanded,
                        }));
                      }}
                    >
                      {isExpanded ? '−' : '+'}
                    </button>
                    <span className="badge badge-bad badge-square">critical</span>
                    <code className="finding-compact-kind" title={finding.kind}>
                      {finding.kind}
                    </code>
                    <span className="mono finding-compact-tx" title={displayId}>
                      {dash.TRANSACTION_HASH_PATTERN.test(displayId) ? (
                        href === undefined ? (
                          dash.shortAddress(displayId)
                        ) : (
                          <a href={href} target="_blank" rel="noreferrer">
                            {dash.shortAddress(displayId)}
                          </a>
                        )
                      ) : (
                        dash.shortAddress(displayId)
                      )}
                    </span>
                    <span className="mono finding-compact-value">
                      {finding.valueWei === undefined
                        ? '—'
                        : dash.formatFindingWei(finding.valueWei)}
                    </span>
                  </div>
                  {canAcknowledge ? (
                    <div className="finding-compact-ack">
                      <input
                        type="text"
                        className="ack-note ack-note-inline"
                        value={draft}
                        disabled={isBusy}
                        placeholder="Acknowledgement note (required)"
                        aria-label={`Acknowledgement note for ${finding.kind}`}
                        onChange={(event) => {
                          const value = event.target.value;
                          setAckDraftByEntityId((prev) => ({
                            ...prev,
                            [entityKey]: value,
                          }));
                        }}
                      />
                      <button
                        type="button"
                        className="secondary"
                        disabled={isBusy}
                        onClick={() => void onAcknowledgeFindingByEntity(finding, entityKey)}
                      >
                        {isBusy ? 'Acknowledging…' : 'Acknowledge'}
                      </button>
                    </div>
                  ) : (
                    <p className="muted finding-compact-ack-unavailable">
                      Cannot acknowledge — finding has no stable entity key.
                    </p>
                  )}
                  {ackError !== undefined ? <p className="error-inline">{ackError}</p> : null}
                  {isExpanded
                    ? renderCriticalFindingDetail(finding, displayId, href, undefined)
                    : null}
                </article>
              );
            };

            const renderAcknowledgedCriticalFinding = (
              finding: FindingView,
              index: number,
              acknowledgement: AlertResource | undefined,
            ) => {
              const entityId =
                dash.findingAlertEntityId(finding) ?? finding.transactionHash ?? finding.kind;
              const href = dash.explorerTxUrl(
                treasuries,
                finding.treasuryId,
                finding.transactionHash,
              );
              return (
                <article
                  key={`ack-${finding.runId}-${finding.kind}-${String(index)}`}
                  className="finding finding-acknowledged"
                >
                  <div className="finding-head">
                    <span className="badge badge-ok badge-square">acknowledged</span>
                    <code>{finding.kind}</code>
                  </div>
                  {renderCriticalFindingDetail(finding, entityId, href, acknowledgement)}
                </article>
              );
            };
            return (
              <>
                <div
                  className={
                    summaryNeedsAttention
                      ? 'recon-summary recon-summary-alert'
                      : 'recon-summary'
                  }
                >
                  <button
                    type="button"
                    className="recon-toggle"
                    aria-expanded={reconciliationDetailExpanded}
                    aria-controls="reconciliation-detail"
                    title={
                      reconciliationDetailExpanded
                        ? 'Collapse acknowledged findings, warnings, and run history'
                        : 'Expand acknowledged findings, warnings, and run history'
                    }
                    onClick={onToggleReconciliationDetail}
                  >
                    {reconciliationDetailExpanded ? '−' : '+'}
                  </button>
                  <p className="recon-summary-text">
                    <span>
                      {String(reconciliationRunsTotal)} run
                      {reconciliationRunsTotal === 1 ? '' : 's'}
                    </span>
                    <span aria-hidden="true"> · </span>
                    {hasUnacknowledgedCritical ? (
                      <span className="recon-critical-callout">{criticalLabel}</span>
                    ) : (
                      <span>{criticalLabel}</span>
                    )}
                    {otherFindings.length > 0 ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span className="recon-critical-callout">
                          {otherFindings.length === 1
                            ? '1 unclassified finding'
                            : `${String(otherFindings.length)} unclassified findings`}
                        </span>
                      </>
                    ) : null}
                    {newestRun !== undefined ? (
                      <>
                        <span aria-hidden="true"> · </span>
                        <span>{dash.lastRunSummaryClause(newestRun)}</span>
                      </>
                    ) : null}
                  </p>
                </div>

                {/*
            Unacknowledged critical findings stay outside the collapse.
            Acknowledgement is a deliberate human act with a required note
            (C20); until that evidence exists — including while alerts are
            still loading or the fetch failed — collapsing must never hide
            a critical (TX.20 / C17).
          */}
                {hasUnacknowledgedCritical ? (
                  <div className="finding-list recon-critical-always">
                    {unacknowledgedCriticalFindings.map((finding, index) =>
                      renderUnacknowledgedCriticalFinding(finding, index),
                    )}
                  </div>
                ) : null}

                {/*
            Unclassified findings stay outside the collapse too (planner
            review, TX.18). A severity this dashboard cannot recognise is
            not evidence that the finding is minor — C18's rule is that the
            system must not make the benign-vs-hostile call it cannot make.
            Filing them under "Warning findings" asserted exactly that, and
            the default-collapsed state then hid them entirely. They have no
            alert row, so TX.20's "no match ⇒ unacknowledged" rule keeps them
            here without a special case.
          */}
                {otherFindings.length > 0 ? (
                  <div className="finding-list recon-critical-always">
                    {otherFindings.map((finding, index) => (
                      <article
                        key={`unclassified-${finding.runId}-${finding.kind}-${String(index)}`}
                        className="finding finding-unknown"
                      >
                        <div className="finding-head">
                          <span className="badge badge-unknown badge-square">unclassified</span>
                          <code>{finding.kind}</code>
                        </div>
                        <dl className="facts">
                          <div>
                            <dt>Severity</dt>
                            <dd>
                              <code>{finding.severity}</code>
                            </dd>
                          </div>
                          <div>
                            <dt>Run</dt>
                            <dd>
                              <code>{finding.runId}</code>
                              <span className="muted">
                                {' '}
                                · {dash.formatTimestamp(finding.runStartedAt)}
                              </span>
                            </dd>
                          </div>
                        </dl>
                        {finding.reason !== undefined ? (
                          <p className="muted">{finding.reason}</p>
                        ) : null}
                      </article>
                    ))}
                  </div>
                ) : null}

                {reconciliationDetailExpanded ? (
                  <div id="reconciliation-detail">
                    <p className="muted">
                      Showing {String(reconciliationRuns.length)} of{' '}
                      {String(reconciliationRunsTotal)} runs (newest first). Findings below are
                      from this page only — older critical findings outside the window will not
                      appear here.
                    </p>

                    {!hasCritical ? (
                      <p className="muted">No critical findings in the loaded runs.</p>
                    ) : null}

                    {acknowledgedCriticalFindings.length > 0 ? (
                      <>
                        <h3 className="subsection-title">Acknowledged critical findings</h3>
                        <p className="muted">
                          Acknowledged findings stay in the run record with their note —
                          collapsing hides them from the always-visible block only after an
                          operator stands them down (C20 / TX.20).
                        </p>
                        <div className="finding-list">
                          {acknowledgedCriticalFindings.map((finding, index) =>
                            renderAcknowledgedCriticalFinding(
                              finding,
                              index,
                              dash.matchingAcknowledgedAlert(finding, acknowledgedFindingAlerts),
                            ),
                          )}
                        </div>
                      </>
                    ) : null}

                    <h3 className="subsection-title">Warning findings</h3>
                    {warningFindings.length === 0 ? (
                      <p className="muted">No warning findings in the loaded runs.</p>
                    ) : (
                      <div className="finding-list">
                        {warningFindings.map((finding, index) => (
                          <article
                            key={`warn-${finding.runId}-${finding.kind}-${String(index)}`}
                            className={
                              finding.severity === 'warning'
                                ? 'finding finding-warning'
                                : 'finding finding-unknown'
                            }
                          >
                            <div className="finding-head">
                              <span
                                className={
                                  finding.severity === 'warning'
                                    ? 'badge badge-warn'
                                    : 'badge badge-unknown'
                                }
                              >
                                {finding.severity}
                              </span>
                              <code>{finding.kind}</code>
                            </div>
                            <p className="muted">
                              Run <code>{finding.runId}</code> ·{' '}
                              {dash.formatTimestamp(finding.runStartedAt)}
                              {finding.reason !== undefined ? ` · ${finding.reason}` : ''}
                            </p>
                          </article>
                        ))}
                      </div>
                    )}

                    <h3 className="subsection-title">Run history</h3>
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Started</th>
                            <th>Finished</th>
                            <th>Assessed</th>
                            <th>Funded</th>
                            <th>Blocked</th>
                            <th>Failed</th>
                            <th>Transferred</th>
                            <th>Scan</th>
                            <th>Status</th>
                            <th>Error</th>
                          </tr>
                        </thead>
                        <tbody>
                          {reconciliationRuns.map((run) => {
                            const completion = dash.runCompletionLabel(run);
                            return (
                              <tr key={run.id}>
                                <td>{dash.formatTimestamp(run.startedAt)}</td>
                                <td>
                                  {run.finishedAt === null ? (
                                    <span className="badge badge-warn">unfinished</span>
                                  ) : (
                                    dash.formatTimestamp(run.finishedAt)
                                  )}
                                </td>
                                <td className="mono">{String(run.walletsAssessed)}</td>
                                <td className="mono">{String(run.walletsFunded)}</td>
                                <td className="mono">{String(run.walletsBlocked)}</td>
                                <td className="mono">{String(run.walletsFailed)}</td>
                                <td className="mono">{run.weiTransferredEther} ETH</td>
                                <td>
                                  <span className={dash.statusClass(run.outgoingScanStatus)}>
                                    {run.outgoingScanStatus}
                                  </span>
                                </td>
                                <td>
                                  <span className={completion.className}>
                                    {completion.label}
                                  </span>
                                </td>
                                <td className="mono">{run.errorCode ?? '—'}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </>
            );
          })()
        : null}
    </>
  )}
</section>
  );
}
