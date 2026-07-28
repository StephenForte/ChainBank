import { custom, type Transport } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { createTreasurySigner } from '../../../src/infrastructure/evm/treasury-signer.js';
import { ChainBankError } from '../../../src/domain/errors.js';
import { createLogger } from '../../../src/observability/logger.js';

const SEPOLIA_CHAIN_ID = 11155111;

function testLogger() {
  return createLogger({
    level: 'silent',
    serviceRole: 'web',
    environment: 'local',
  });
}

function chainConfig() {
  return {
    slug: 'ethereum-sepolia',
    chainId: SEPOLIA_CHAIN_ID,
    displayName: 'Ethereum Sepolia',
    nativeSymbol: 'ETH',
    rpcUrl: 'https://rpc.example.test/sepolia',
    explorerBaseUrl: 'https://sepolia.etherscan.io',
  };
}

function mockTransport(handlers: {
  readonly getChainId?: () => number | Promise<number>;
  readonly estimateGas?: () => bigint | Promise<bigint>;
  readonly gasPrice?: () => bigint | Promise<bigint>;
  readonly transactionCount?: () => number | Promise<number>;
  readonly sendRawTransaction?: () => `0x${string}` | Promise<`0x${string}`>;
}): Transport {
  return custom({
    async request({ method }) {
      switch (method) {
        case 'eth_chainId': {
          const chainId = await (handlers.getChainId?.() ?? SEPOLIA_CHAIN_ID);
          return `0x${chainId.toString(16)}`;
        }
        case 'eth_estimateGas': {
          if (handlers.estimateGas === undefined) {
            throw new Error('estimateGas not configured');
          }
          const gas = await handlers.estimateGas();
          return `0x${gas.toString(16)}`;
        }
        case 'eth_gasPrice': {
          if (handlers.gasPrice === undefined) {
            throw new Error('gasPrice not configured');
          }
          const price = await handlers.gasPrice();
          return `0x${price.toString(16)}`;
        }
        case 'eth_getTransactionCount': {
          const count = await (handlers.transactionCount?.() ?? 0);
          return `0x${count.toString(16)}`;
        }
        case 'eth_sendRawTransaction': {
          if (handlers.sendRawTransaction === undefined) {
            throw new Error('sendRawTransaction not configured');
          }
          return await handlers.sendRawTransaction();
        }
        case 'eth_maxPriorityFeePerGas':
          return '0x1';
        case 'eth_feeHistory':
          return {
            oldestBlock: '0x1',
            baseFeePerGas: ['0x1'],
            gasUsedRatio: [0.5],
            reward: [['0x1']],
          };
        default:
          throw new Error(`Unhandled RPC method in test transport: ${method}`);
      }
    },
  });
}

describe('createTreasurySigner', () => {
  it('derives the treasury address from a disposable private key', () => {
    const privateKey = generatePrivateKey();
    const expected = privateKeyToAccount(privateKey).address;
    const signer = createTreasurySigner({
      chain: chainConfig(),
      privateKey,
      isKillSwitchActive: false,
      logger: testLogger(),
      transport: mockTransport({}),
    });

    expect(signer.address).toBe(expected);
  });

  it('refuses to send when the RPC chain ID does not match configuration', async () => {
    const privateKey = generatePrivateKey();
    const signer = createTreasurySigner({
      chain: chainConfig(),
      privateKey,
      isKillSwitchActive: false,
      logger: testLogger(),
      transport: mockTransport({
        getChainId: () => 1,
        sendRawTransaction: () => {
          throw new Error('must not submit');
        },
      }),
    });

    await expect(
      signer.sendNativeTransfer({
        to: privateKeyToAccount(generatePrivateKey()).address,
        valueWei: 1n,
        nonce: 0,
      }),
    ).rejects.toMatchObject({ code: 'SIGNER_CHAIN_MISMATCH' } satisfies Partial<ChainBankError>);
  });

  it('throws FUNDING_DISABLED on send when the kill switch is active', async () => {
    const privateKey = generatePrivateKey();
    const sendRawTransaction = vi.fn((): `0x${string}` => '0xabc');
    const signer = createTreasurySigner({
      chain: chainConfig(),
      privateKey,
      isKillSwitchActive: true,
      logger: testLogger(),
      transport: mockTransport({
        getChainId: () => SEPOLIA_CHAIN_ID,
        sendRawTransaction,
      }),
    });

    await expect(
      signer.sendNativeTransfer({
        to: privateKeyToAccount(generatePrivateKey()).address,
        valueWei: 1n,
        nonce: 0,
      }),
    ).rejects.toMatchObject({ code: 'FUNDING_DISABLED' } satisfies Partial<ChainBankError>);
    expect(sendRawTransaction).not.toHaveBeenCalled();
  });

  it('keeps read paths working while the kill switch is active', async () => {
    const privateKey = generatePrivateKey();
    const signer = createTreasurySigner({
      chain: chainConfig(),
      privateKey,
      isKillSwitchActive: true,
      logger: testLogger(),
      transport: mockTransport({
        getChainId: () => SEPOLIA_CHAIN_ID,
        transactionCount: () => 7,
        estimateGas: () => 21_000n,
        gasPrice: () => 1_000_000_000n,
      }),
    });

    await expect(signer.verifyChainId()).resolves.toEqual({
      matches: true,
      observedChainId: SEPOLIA_CHAIN_ID,
    });
    await expect(signer.getTransactionCount()).resolves.toBe(7);
    await expect(
      signer.estimateTransferCostWei(privateKeyToAccount(generatePrivateKey()).address, 1n),
    ).resolves.toBe(21_000n * 1_000_000_000n);
  });

  it('fails closed when gas estimation fails', async () => {
    const privateKey = generatePrivateKey();
    const signer = createTreasurySigner({
      chain: chainConfig(),
      privateKey,
      isKillSwitchActive: false,
      logger: testLogger(),
      transport: mockTransport({
        estimateGas: () => {
          throw new Error('gas estimation unavailable');
        },
      }),
    });

    await expect(
      signer.estimateTransferCostWei(privateKeyToAccount(generatePrivateKey()).address, 1n),
    ).rejects.toMatchObject({ code: 'GAS_ESTIMATION_FAILED' } satisfies Partial<ChainBankError>);
  });

  it('stringifies thrown signer errors without private key material', async () => {
    const privateKey = generatePrivateKey();
    const signer = createTreasurySigner({
      chain: chainConfig(),
      privateKey,
      isKillSwitchActive: true,
      logger: testLogger(),
      transport: mockTransport({ getChainId: () => SEPOLIA_CHAIN_ID }),
    });

    let caught: unknown;
    try {
      await signer.sendNativeTransfer({
        to: privateKeyToAccount(generatePrivateKey()).address,
        valueWei: 1n,
        nonce: 0,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ChainBankError);
    const error = caught as ChainBankError;
    const serialized = JSON.stringify({
      name: error.name,
      message: error.message,
      code: error.code,
      publicMessage: error.publicMessage,
      context: error.context,
      stack: error.stack,
      string: String(error),
    });

    expect(serialized).not.toContain(privateKey);
    expect(serialized).not.toContain(privateKey.slice(2));
  });
});
