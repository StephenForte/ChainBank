import type { ReconciliationPanelProps } from './panels/reconciliation-panel';
import { ReconciliationPage } from './reconciliation';

/**
 * Findings stay in the reconciliation panel (C20 / C30). This route renders that
 * same panel — it does not call the API on its own.
 */
export function AlertsPage(props: { readonly panel: ReconciliationPanelProps }) {
  return (
    <>
      <p className="page-lead">
        Unacknowledged findings, acknowledgements, and dark-chain warnings stay in the reconciliation panel.
        This page does not load a separate feed. <a href="#/reconciliation">Open reconciliation</a>
      </p>
      <ReconciliationPage panel={props.panel} />
    </>
  );
}
