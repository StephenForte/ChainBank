import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Phase 0 exit criterion: no process can send ETH yet.
 *
 * This scan is a tripwire. If a future change introduces a wallet client or
 * private-key import into the runtime source tree, this test fails before that
 * code can ship under the Phase 0 "read-only" claim.
 */
const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  { label: 'createWalletClient', pattern: /\bcreateWalletClient\b/ },
  { label: 'privateKeyToAccount', pattern: /\bprivateKeyToAccount\b/ },
  { label: 'mnemonicToAccount', pattern: /\bmnemonicToAccount\b/ },
  { label: 'sendTransaction', pattern: /\bsendTransaction\b/ },
  { label: 'signTransaction', pattern: /\bsignTransaction\b/ },
];

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

describe('Phase 0 signing-path absence', () => {
  it('contains no wallet-client or transaction-signing APIs in src/', () => {
    const files = walkTypeScriptFiles(join(process.cwd(), 'src'));
    const violations: string[] = [];

    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const forbidden of FORBIDDEN_PATTERNS) {
        if (forbidden.pattern.test(source)) {
          violations.push(`${file}: ${forbidden.label}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
