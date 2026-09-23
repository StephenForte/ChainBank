import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { EnvironmentsPanel, type EnvironmentsPanelProps } from './panels/environments-panel';
import { FundingPolicyPanel, type FundingPolicyPanelProps } from './panels/funding-policy-panel';
import { ManagedWalletsPanel, type ManagedWalletsPanelProps } from './panels/managed-wallets-panel';
import { ProjectsPanel, type ProjectsPanelProps } from './panels/projects-panel';
import { RegisterWalletPanel, type RegisterWalletPanelProps } from './panels/register-wallet-panel';

export type WalletsPageProps = {
  readonly projects: ProjectsPanelProps;
  readonly environments: EnvironmentsPanelProps;
  readonly registration: RegisterWalletPanelProps;
  readonly wallets: ManagedWalletsPanelProps;
  readonly policy: FundingPolicyPanelProps;
};

export function WalletsPage({ projects, environments, registration, wallets, policy }: WalletsPageProps) {
  return (
    <>
      <div className="workspace-split">
        <PanelErrorBoundary panelName="Projects" severity="quiet">
          <PanelBody render={() => <ProjectsPanel {...projects} />} />
        </PanelErrorBoundary>
        <PanelErrorBoundary panelName="Environments" severity="quiet">
          <PanelBody render={() => <EnvironmentsPanel {...environments} />} />
        </PanelErrorBoundary>
      </div>
      <PanelErrorBoundary panelName="Register wallet" severity="quiet">
        <PanelBody render={() => <RegisterWalletPanel {...registration} />} />
      </PanelErrorBoundary>
      <PanelErrorBoundary panelName="Managed wallets" severity="elevated">
        <PanelBody render={() => <ManagedWalletsPanel {...wallets} />} />
      </PanelErrorBoundary>
      <PanelErrorBoundary panelName="Funding policy" severity="quiet">
        <PanelBody render={() => <FundingPolicyPanel {...policy} />} />
      </PanelErrorBoundary>
    </>
  );
}
