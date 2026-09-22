import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { FundingHistoryPanel, type FundingHistoryPanelProps } from './panels/funding-history-panel';

export function FundingPage(props: { readonly history: FundingHistoryPanelProps }) {
  return (
    <PanelErrorBoundary panelName="Funding history" severity="quiet">
      <PanelBody render={() => <FundingHistoryPanel {...props.history} />} />
    </PanelErrorBoundary>
  );
}
