import type { ChainAdapterRegistry } from '../ports.js';
import { ChainBankError } from '../../domain/errors.js';
import type { Logger } from '../../observability/logger.js';

/**
 * One configured chain's boot-time chain-id proof (C28).
 *
 * `matched` means the RPC reported the chain id this adapter is registered
 * under. `unreachable` means the RPC did not answer. Those are different
 * outcomes: an unreachable endpoint is not evidence the URL points at the
 * wrong chain, and a reported mismatch is not an outage to retry.
 */
export type ChainIdProof =
  | {
      readonly kind: 'matched';
      readonly chainId: number;
      readonly observedChainId: number;
    }
  | {
      readonly kind: 'unreachable';
      readonly chainId: number;
    };

/**
 * Proves every configured RPC reports the chain id its adapter is registered
 * under. Call this after the container exists and before the process accepts
 * work that could use a signer (web: before `listen`; crons: before the run).
 *
 * A reported chain id other than the registration key throws
 * `INVALID_CONFIGURATION`. That category is validation, so the failure is not
 * a transient provider error and the process must not start. An RPC that
 * cannot be read (`observedChainId` undefined) is returned as `unreachable`
 * and does not throw — a blip must not be stored as a wrong-chain configuration.
 * The send path still refuses to sign until a later read confirms the id.
 */
export async function proveConfiguredChainIds(
  chainAdapters: ChainAdapterRegistry,
  logger: Logger,
): Promise<readonly ChainIdProof[]> {
  const proofs: ChainIdProof[] = [];

  for (const chainId of chainAdapters.registeredChainIds) {
    const verification = await chainAdapters.balanceReader(chainId).verifyChainId();
    if (verification.observedChainId === undefined) {
      logger.warn({ chainId }, 'RPC chain id was unreadable at startup. This is not a chain mismatch.');
      proofs.push({ kind: 'unreachable', chainId });
      continue;
    }

    if (verification.observedChainId !== chainId || !verification.matches) {
      throw new ChainBankError(
        'INVALID_CONFIGURATION',
        `RPC for configured chain ${String(chainId)} reports chain ${String(verification.observedChainId)}. Refusing to start.`,
        {
          publicMessage: 'The service is misconfigured.',
          context: {
            configuredChainId: chainId,
            observedChainId: verification.observedChainId,
          },
        },
      );
    }

    proofs.push({
      kind: 'matched',
      chainId,
      observedChainId: verification.observedChainId,
    });
  }

  logger.info(
    { chains: proofs.map((proof) => ({ chainId: proof.chainId, kind: proof.kind })) },
    'Startup chain-id proof finished',
  );

  return proofs;
}
