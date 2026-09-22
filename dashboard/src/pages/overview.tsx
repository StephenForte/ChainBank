import { IconOverview, IconTreasuries } from '../icons';
import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { StatCard } from '../primitives';
import { ServiceReadinessPanel, type ServiceReadinessPanelProps } from './panels/service-readiness-panel';
import { TreasuriesPanel, type TreasuriesPanelProps } from './panels/treasuries-panel';

export type OverviewPageProps = {
  readonly readiness: ServiceReadinessPanelProps;
  readonly treasuries: TreasuriesPanelProps;
};

export function OverviewPage({ readiness, treasuries }: OverviewPageProps) {
  const readinessValue =
    readiness.readinessState === 'ready' && readiness.readiness !== undefined
      ? readiness.readiness.status
      : '—';
  const treasuryValue = treasuries.treasuriesState === 'ready' ? String(treasuries.treasuries.length) : '—';

  return (
    <>
      <div className="stat-row">
        <StatCard label="Readiness" value={readinessValue} icon={<IconOverview />} />
        <StatCard label="Treasuries" value={treasuryValue} icon={<IconTreasuries />} />
      </div>
      <PanelErrorBoundary panelName="Service readiness" severity="elevated">
        <PanelBody render={() => <ServiceReadinessPanel {...readiness} />} />
      </PanelErrorBoundary>
      <PanelErrorBoundary panelName="Treasuries" severity="alarm">
        <PanelBody render={() => <TreasuriesPanel {...treasuries} />} />
      </PanelErrorBoundary>
    </>
  );
}
