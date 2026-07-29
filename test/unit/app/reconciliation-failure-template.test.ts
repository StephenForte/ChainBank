import { describe, expect, it } from 'vitest';
import { renderReconciliationFailureEmail } from '../../../src/app/email/reconciliation-failure-template.js';

const BASE_CONTEXT = {
  environment: 'local',
  consecutiveFailureCount: 3,
  affectedWallets: [
    {
      projectSlug: 'forte-app',
      environmentSlug: 'staging',
      walletAddressDisplay: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    },
  ],
  errorCategories: ['GAS_ESTIMATION_FAILED', 'RESERVE_BLOCKED'],
  dashboardBaseUrl: 'http://localhost:3000',
} as const;

describe('renderReconciliationFailureEmail', () => {
  it('renders affected wallets, error categories, and dashboard link', () => {
    const message = renderReconciliationFailureEmail(BASE_CONTEXT);

    expect(message.subject).toContain('[RECONCILE]');
    expect(message.subject).toContain('3');
    expect(message.text).toContain('forte-app/staging');
    expect(message.text).toContain(BASE_CONTEXT.affectedWallets[0].walletAddressDisplay);
    expect(message.text).toContain('GAS_ESTIMATION_FAILED');
    expect(message.text).toContain('RESERVE_BLOCKED');
    expect(message.text).toContain('Recommended action');
    expect(message.text).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.html).toContain('forte-app/staging');
    expect(message.html).toContain(BASE_CONTEXT.affectedWallets[0].walletAddressDisplay);
    expect(message.html).toContain('GAS_ESTIMATION_FAILED');
    expect(message.html).toContain(BASE_CONTEXT.dashboardBaseUrl);
    expect(message.text).not.toMatch(/re_|sk_|private|api[_-]?key/i);
    expect(message.html).not.toMatch(/re_|sk_|private|api[_-]?key/i);
  });

  it('escapes HTML in operator-facing fields', () => {
    const message = renderReconciliationFailureEmail({
      ...BASE_CONTEXT,
      errorCategories: ['<script>alert(1)</script>'],
    });

    expect(message.html).not.toContain('<script>alert(1)</script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});
