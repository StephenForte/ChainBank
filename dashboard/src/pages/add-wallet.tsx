import { PanelBody, PanelErrorBoundary } from '../panel-error-boundary';
import { RegisterWalletPanel, type RegisterWalletPanelProps } from './panels/register-wallet-panel';
import { useHasPermission } from '../session/permissions';

export type AddWalletPageProps = {
  readonly registration: RegisterWalletPanelProps;
};

export function AddWalletPage({ registration }: AddWalletPageProps) {
  const canWrite = useHasPermission('wallet:write');
  if (!canWrite) {
    return (
      <section className="panel">
        <h2 className="section-title">Add wallet</h2>
        <p>You do not have permission to add a wallet.</p>
      </section>
    );
  }

  return (
    <PanelErrorBoundary panelName="Register wallet" severity="quiet">
      <PanelBody render={() => <RegisterWalletPanel {...registration} />} />
    </PanelErrorBoundary>
  );
}
