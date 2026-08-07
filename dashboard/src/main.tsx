import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { PanelErrorBoundary } from './panel-error-boundary';
import './styles.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Dashboard root element was not found.');
}

createRoot(root, {
  onUncaughtError(error, errorInfo) {
    // C22: escapes past panel boundaries must still be diagnosable.
    // eslint-disable-next-line no-console -- intentional operator-facing diagnostics
    console.error('[ChainBank] Uncaught render error', error, errorInfo.componentStack ?? '');
  },
}).render(
  <StrictMode>
    <PanelErrorBoundary panelName="Operator console" severity="alarm" isRoot>
      <App />
    </PanelErrorBoundary>
  </StrictMode>,
);
