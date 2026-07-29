import { ChainBankError } from '../errors.js';

/** Lowercase DNS-like segment: letters, digits, hyphens; no leading/trailing hyphen. */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIN_SLUG_LENGTH = 2;
const MAX_SLUG_LENGTH = 64;

export type SlugValidationResult =
  { readonly ok: true; readonly slug: string } | { readonly ok: false; readonly message: string };

export function validateSlug(raw: string): SlugValidationResult {
  const slug = raw.trim().toLowerCase();
  if (slug.length < MIN_SLUG_LENGTH || slug.length > MAX_SLUG_LENGTH) {
    return {
      ok: false,
      message: `Slug must be between ${String(MIN_SLUG_LENGTH)} and ${String(MAX_SLUG_LENGTH)} characters.`,
    };
  }
  if (!SLUG_PATTERN.test(slug)) {
    return {
      ok: false,
      message:
        'Slug must contain only lowercase letters, digits, and hyphens, and cannot start or end with a hyphen.',
    };
  }
  return { ok: true, slug };
}

export function parseSlug(raw: string, fieldName: string): string {
  const result = validateSlug(raw);
  if (!result.ok) {
    throw new ChainBankError('INVALID_REQUEST', `${fieldName}: ${result.message}`, {
      publicMessage: result.message,
      context: { field: fieldName },
    });
  }
  return result.slug;
}
