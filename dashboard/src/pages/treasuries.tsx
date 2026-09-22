import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { TreasuriesPanel, type TreasuriesPanelProps } from './panels/treasuries-panel';

export function TreasuriesPage(props: { readonly treasuries: TreasuriesPanelProps }) {
  return (
    <PanelErrorBoundary panelName="Treasuries" severity="alarm">
      <PanelBody render={() => <TreasuriesPanel {...props.treasuries} />} />
    </PanelErrorBoundary>
  );
}
