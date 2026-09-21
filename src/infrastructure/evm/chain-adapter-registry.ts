import type {
  BalanceReader,
  ChainAdapterRegistry,
  TransactionReceiptTracker,
  TreasuryOutgoingScanner,
  TreasurySigner,
} from '../../app/ports.js';
import { ChainBankError } from '../../domain/errors.js';

/**
 * One chain's adapters. Readers and signers must already be bound to `chainId`;
 * the registry refuses a registration that says otherwise, so a Sepolia signer
 * cannot be stored under another chain's key.
 */
export interface ChainAdapterRegistration {
  readonly chainId: number;
  readonly balanceReader: BalanceReader;
  readonly receiptTracker: TransactionReceiptTracker;
  readonly outgoingScanner: TreasuryOutgoingScanner;
  /**
   * Signers that may spend on this chain, in priority order. The first signer
   * for a given address wins (operational before external, matching C25).
   */
  readonly signers?: readonly TreasurySigner[];
  /** Public key used for replenish. Distinct from address matching. */
  readonly externalSigner?: TreasurySigner;
}

interface RegisteredChain {
  readonly chainId: number;
  readonly balanceReader: BalanceReader;
  readonly receiptTracker: TransactionReceiptTracker;
  readonly outgoingScanner: TreasuryOutgoingScanner;
  readonly signersByAddress: ReadonlyMap<string, TreasurySigner>;
  readonly externalSigner: TreasurySigner | undefined;
}

/**
 * Fail-closed chain adapter map (C26).
 *
 * Lookup never falls through to another chain or to "the one we have".
 * An empty list is legal for a caller that never touches a chain; asking it
 * for any chain id still throws.
 */
export function createChainAdapterRegistry(
  registrations: readonly ChainAdapterRegistration[],
): ChainAdapterRegistry {
  const byChainId = new Map<number, RegisteredChain>();

  for (const registration of registrations) {
    if (byChainId.has(registration.chainId)) {
      throw new ChainBankError(
        'INVALID_CONFIGURATION',
        `Chain ${String(registration.chainId)} is registered more than once`,
        { publicMessage: 'The service is misconfigured.' },
      );
    }
    byChainId.set(registration.chainId, freezeRegistration(registration));
  }

  const registeredChainIds = registrations.map((registration) => registration.chainId);
  const canSign = [...byChainId.values()].some(
    (chain) => chain.signersByAddress.size > 0 || chain.externalSigner !== undefined,
  );

  function requireChain(chainId: number): RegisteredChain {
    const chain = byChainId.get(chainId);
    if (chain === undefined) {
      throw new ChainBankError(
        'INVALID_CONFIGURATION',
        `No chain adapters are registered for chain id ${String(chainId)}`,
        { publicMessage: 'The service is misconfigured.' },
      );
    }
    return chain;
  }

  return {
    registeredChainIds,
    canSign,

    balanceReader(chainId) {
      return requireChain(chainId).balanceReader;
    },

    receiptTracker(chainId) {
      return requireChain(chainId).receiptTracker;
    },

    outgoingScanner(chainId) {
      return requireChain(chainId).outgoingScanner;
    },

    getSignerForTreasury(treasury) {
      const chain = requireChain(treasury.chain.chainId);
      if (!canSign) {
        throw new ChainBankError('SIGNER_UNAVAILABLE', 'No treasury signer is configured for this process.', {
          publicMessage: 'Funding is unavailable because the treasury signer is not configured.',
        });
      }
      const signer = chain.signersByAddress.get(treasury.address.toLowerCase());
      if (signer === undefined || signer.chainId !== treasury.chain.chainId) {
        throw new ChainBankError(
          'INVALID_CONFIGURATION',
          `No signer is configured for treasury ${treasury.id} on chain ${String(treasury.chain.chainId)}`,
          { publicMessage: 'Funding is unavailable because the treasury signer is misconfigured.' },
        );
      }
      return signer;
    },

    externalSigner(chainId) {
      return requireChain(chainId).externalSigner;
    },
  };
}

function freezeRegistration(registration: ChainAdapterRegistration): RegisteredChain {
  if (registration.balanceReader.chainId !== registration.chainId) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `Balance reader for chain ${String(registration.balanceReader.chainId)} cannot be registered under chain ${String(registration.chainId)}`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }

  const signersByAddress = new Map<string, TreasurySigner>();
  for (const signer of registration.signers ?? []) {
    assertSignerChain(signer, registration.chainId);
    const address = signer.address.toLowerCase();
    if (!signersByAddress.has(address)) {
      signersByAddress.set(address, signer);
    }
  }

  if (registration.externalSigner !== undefined) {
    assertSignerChain(registration.externalSigner, registration.chainId);
  }

  return {
    chainId: registration.chainId,
    balanceReader: registration.balanceReader,
    receiptTracker: registration.receiptTracker,
    outgoingScanner: registration.outgoingScanner,
    signersByAddress,
    externalSigner: registration.externalSigner,
  };
}

function assertSignerChain(signer: TreasurySigner, chainId: number): void {
  if (signer.chainId !== chainId) {
    throw new ChainBankError(
      'INVALID_CONFIGURATION',
      `Signer for chain ${String(signer.chainId)} cannot be registered under chain ${String(chainId)}`,
      { publicMessage: 'The service is misconfigured.' },
    );
  }
}
