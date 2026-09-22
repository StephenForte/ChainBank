import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { ReconciliationPanel, type ReconciliationPanelProps } from './panels/reconciliation-panel';

export function ReconciliationPage(props: { readonly panel: ReconciliationPanelProps }) {
  return (
    <PanelErrorBoundary panelName="Reconciliation" severity="alarm">
      <PanelBody render={() => <ReconciliationPanel {...props.panel} />} />
    </PanelErrorBoundary>
  );
}
