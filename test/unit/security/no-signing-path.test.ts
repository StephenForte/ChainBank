import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Signing-path boundary tripwire.
 *
 * Wallet-client and private-key APIs may exist only inside the dedicated
 * treasury signer adapter. Every other runtime module must remain read-only
 * with respect to transaction submission.
 */
const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'createWalletClient', pattern: /\bcreateWalletClient\b/ },
  { label: 'privateKeyToAccount', pattern: /\bprivateKeyToAccount\b/ },
  { label: 'mnemonicToAccount', pattern: /\bmnemonicToAccount\b/ },
  { label: 'sendTransaction', pattern: /\bsendTransaction\b/ },
  { label: 'signTransaction', pattern: /\bsignTransaction\b/ },
];

const SIGNING_ADAPTER_RELATIVE = join('src', 'infrastructure', 'evm', 'treasury-signer.ts');

function walkTypeScriptFiles(root: string): readonly string[] {
  const collected: string[] = [];
  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      collected.push(...walkTypeScriptFiles(path));
      continue;
    }
    if (path.endsWith('.ts') && !path.endsWith('.test.ts')) {
      collected.push(path);
    }
  }
  return collected;
}

describe('signing-path boundary', () => {
  it('confines wallet-client and transaction-signing APIs to treasury-signer.ts', () => {
    const srcRoot = join(process.cwd(), 'src');
    const files = walkTypeScriptFiles(srcRoot);
    const violations: string[] = [];
    let adapterSeen = false;

    for (const file of files) {
      const relativePath = relative(process.cwd(), file);
      const source = readFileSync(file, 'utf8');
      const isAdapter = relativePath === SIGNING_ADAPTER_RELATIVE;

      if (isAdapter) {
        adapterSeen = true;
        for (const required of ['createWalletClient', 'privateKeyToAccount', 'sendTransaction'] as const) {
          expect(source, `adapter must use ${required}`).toMatch(new RegExp(`\\b${required}\\b`));
        }
        continue;
      }

      for (const forbidden of FORBIDDEN_PATTERNS) {
        if (forbidden.pattern.test(source)) {
          violations.push(`${relativePath}: ${forbidden.label}`);
        }
      }
    }

    expect(adapterSeen).toBe(true);
    expect(violations).toEqual([]);
  });
});
