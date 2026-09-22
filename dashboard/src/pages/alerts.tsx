import type { ReconciliationPanelProps } from './panels/reconciliation-panel';
import { ReconciliationPage } from './reconciliation';

/**
 * Findings stay in the reconciliation panel (C20 / C30). This route renders that
 * same panel — it does not call the API on its own. Unacknowledged criticals
 * ignore the chain filter and name their chain (C34).
 */
export function AlertsPage(props: { readonly panel: ReconciliationPanelProps }) {
  return (
    <>
      <p className="page-lead">
        Unacknowledged critical findings from every chain stay listed here, with the chain name on each. Other
        reconciliation rows follow the chain filter. <a href="#/reconciliation">Open reconciliation</a>
      </p>
      <ReconciliationPage panel={{ ...props.panel, listEveryCritical: true }} />
    </>
  );
}
