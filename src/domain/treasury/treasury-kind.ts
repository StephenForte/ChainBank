/**
 * Two-tier treasury kinds (D11 / C23).
 *
 * Code and database use these strings. Dashboard copy is Public / Private.
 * Do not name the kind `public` — the PRD already uses that word for faucets.
 */
export const TREASURY_KINDS = ['external', 'operational'] as const;

export type TreasuryKind = (typeof TREASURY_KINDS)[number];

export function isTreasuryKind(value: unknown): value is TreasuryKind {
  return typeof value === 'string' && (TREASURY_KINDS as readonly string[]).includes(value);
}

/** Operator-facing label. Never persist this string. */
export function treasuryKindDisplayName(kind: TreasuryKind): 'Public' | 'Private' {
  return kind === 'external' ? 'Public' : 'Private';
}
