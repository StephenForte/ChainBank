/**
 * Minimal valid environment for config-loader tests.
 *
 * Uses a well-known Sepolia address (Vitalik's) only as a syntactically valid
 * placeholder — never as a live treasury. Secrets here are disposable fixtures.
 */
export function validWebEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    CHAINBANK_ENVIRONMENT: 'local',
    LOG_LEVEL: 'error',
    PORT: '3000',
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: 'http://localhost:3000',
    DATABASE_URL: 'postgres://chainbank:chainbank@127.0.0.1:5432/chainbank_test',
    CHAIN_ID: '11155111',
    CHAIN_RPC_URL: 'https://rpc.example.test/sepolia',
    TREASURY_ADDRESS: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    TREASURY_WARNING_BALANCE_ETH: '1',
    TREASURY_CRITICAL_BALANCE_ETH: '0.25',
    TREASURY_RECOVERY_BALANCE_ETH: '2',
    TREASURY_MINIMUM_RESERVE_ETH: '0.5',
    EMAIL_PROVIDER: 'log-only',
    EMAIL_FROM_ADDRESS: 'chainbank@example.com',
    EMAIL_OPERATOR_RECIPIENTS: 'operator@example.com',
    FUNDING_ENABLED: 'false',
    FUNDING_KILL_SWITCH: 'false',
    ...overrides,
  };
}

/**
 * Monitor role receives email settings for alert delivery but never signing
 * material. Email vars come from validWebEnv unless overridden.
 */
export function validMonitorEnv(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  return validWebEnv(overrides);
}
