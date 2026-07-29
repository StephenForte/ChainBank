import type {
  ApiCredentialRepository,
  AuditEventRepository,
  BalanceObservationRepository,
  BalanceReader,
  ChainRepository,
  CredentialScopeRepository,
  EmailSender,
  EnvironmentRepository,
  FundingPolicyRepository,
  ManagedWalletRepository,
  ProjectRepository,
  ServiceHeartbeatRepository,
  TreasuryRepository,
  TreasurySigner,
} from './app/ports.js';
import { getTreasuryPrivateKey, isSigningCapableRole, type ChainBankConfig } from './config/index.js';
import type { Clock, IdGenerator } from './domain/ports.js';
import { createDatabase, type DatabaseHandle } from './infrastructure/db/client.js';
import { createApiCredentialRepository } from './infrastructure/db/repositories/api-credential-repository.js';
import { createAuditEventRepository } from './infrastructure/db/repositories/audit-event-repository.js';
import { createBalanceObservationRepository } from './infrastructure/db/repositories/balance-observation-repository.js';
import { createChainRepository } from './infrastructure/db/repositories/chain-repository.js';
import { createCredentialScopeRepository } from './infrastructure/db/repositories/credential-scope-repository.js';
import { createEnvironmentRepository } from './infrastructure/db/repositories/environment-repository.js';
import { createFundingPolicyRepository } from './infrastructure/db/repositories/funding-policy-repository.js';
import { createManagedWalletRepository } from './infrastructure/db/repositories/managed-wallet-repository.js';
import { createProjectRepository } from './infrastructure/db/repositories/project-repository.js';
import { createServiceHeartbeatRepository } from './infrastructure/db/repositories/service-heartbeat-repository.js';
import { createTreasuryRepository } from './infrastructure/db/repositories/treasury-repository.js';
import { createLogOnlyEmailSender } from './infrastructure/email/log-only-email-sender.js';
import { createResendEmailSender } from './infrastructure/email/resend-email-sender.js';
import { createBalanceReader } from './infrastructure/evm/balance-reader.js';
import { createTreasurySigner } from './infrastructure/evm/treasury-signer.js';
import { createLogger, type Logger } from './observability/logger.js';
import { systemClock, uuidGenerator } from './shared/system-ports.js';

/**
 * Composition root.
 *
 * Every concrete adapter is constructed here and nowhere else, so the set of
 * capabilities a process holds is visible in one place. The treasury signer is
 * constructed only for signing-capable roles that hold a validated private key.
 */
export interface Container {
  readonly config: ChainBankConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly database: DatabaseHandle;
  readonly repositories: {
    readonly chains: ChainRepository;
    readonly treasuries: TreasuryRepository;
    readonly balanceObservations: BalanceObservationRepository;
    readonly apiCredentials: ApiCredentialRepository;
    readonly auditEvents: AuditEventRepository;
    readonly serviceHeartbeats: ServiceHeartbeatRepository;
    readonly managedWallets: ManagedWalletRepository;
    readonly fundingPolicies: FundingPolicyRepository;
    readonly projects: ProjectRepository;
    readonly environments: EnvironmentRepository;
    readonly credentialScopes: CredentialScopeRepository;
  };
  readonly balanceReader: BalanceReader;
  /** Present only for signing-capable roles with a validated treasury key. */
  readonly treasurySigner: TreasurySigner | undefined;
  /** Absent for roles that hold no email credentials. */
  readonly emailSender: EmailSender | undefined;
  close(): Promise<void>;
}

export interface BuildContainerOptions {
  readonly config: ChainBankConfig;
  readonly clock?: Clock;
  readonly idGenerator?: IdGenerator;
  readonly logger?: Logger;
}

export function buildContainer(options: BuildContainerOptions): Container {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const idGenerator = options.idGenerator ?? uuidGenerator;

  const logger =
    options.logger ??
    createLogger({
      level: config.app.logLevel,
      serviceRole: config.app.serviceRole,
      environment: config.app.environment,
    });

  const database = createDatabase(config.database, logger);

  return {
    config,
    logger,
    clock,
    idGenerator,
    database,
    repositories: {
      chains: createChainRepository(database.db),
      treasuries: createTreasuryRepository(database.db),
      balanceObservations: createBalanceObservationRepository(database.db),
      apiCredentials: createApiCredentialRepository(database.db),
      auditEvents: createAuditEventRepository(database.db),
      serviceHeartbeats: createServiceHeartbeatRepository(database.db),
      managedWallets: createManagedWalletRepository(database.db),
      fundingPolicies: createFundingPolicyRepository(database.db),
      projects: createProjectRepository(database.db),
      environments: createEnvironmentRepository(database.db),
      credentialScopes: createCredentialScopeRepository(database.db),
    },
    balanceReader: createBalanceReader({ chain: config.chain, clock, logger }),
    treasurySigner: buildTreasurySigner(config, logger),
    emailSender: buildEmailSender(config, logger),
    close: async () => {
      await database.close();
    },
  };
}

function buildTreasurySigner(config: ChainBankConfig, logger: Logger): TreasurySigner | undefined {
  if (!isSigningCapableRole(config.app.serviceRole)) {
    return undefined;
  }

  const privateKey = getTreasuryPrivateKey(config);
  if (privateKey === undefined) {
    return undefined;
  }

  return createTreasurySigner({
    chain: config.chain,
    privateKey,
    isKillSwitchActive: config.isFundingKillSwitchActive,
    logger,
  });
}

function buildEmailSender(config: ChainBankConfig, logger: Logger): EmailSender | undefined {
  if (config.email === undefined) {
    return undefined;
  }
  if (config.email.provider === 'log-only') {
    return createLogOnlyEmailSender(logger);
  }
  return createResendEmailSender({
    apiKey: config.email.apiKey,
    fromAddress: config.email.fromAddress,
    logger,
  });
}
