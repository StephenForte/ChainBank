import { describe, expect, it } from 'vitest';
import { parseSlug, validateSlug } from '../../../../src/domain/projects/slug.js';
import { ChainBankError } from '../../../../src/domain/errors.js';

describe('project/environment slug validation', () => {
  it('accepts lowercase alphanumeric slugs with hyphens', () => {
    expect(validateSlug('fortel2')).toEqual({ ok: true, slug: 'fortel2' });
    expect(validateSlug('my-project-2')).toEqual({ ok: true, slug: 'my-project-2' });
    expect(validateSlug('  ForteL2  ')).toEqual({ ok: true, slug: 'fortel2' });
  });

  it('rejects empty, too short, too long, and malformed slugs', () => {
    expect(validateSlug('a').ok).toBe(false);
    expect(validateSlug('-bad').ok).toBe(false);
    expect(validateSlug('bad-').ok).toBe(false);
    expect(validateSlug('has spaces').ok).toBe(false);
    expect(validateSlug('a'.repeat(65)).ok).toBe(false);
  });

  it('throws INVALID_REQUEST from parseSlug', () => {
    expect(() => parseSlug('Bad_Slug', 'slug')).toThrow(ChainBankError);
    try {
      parseSlug('Bad_Slug', 'slug');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_REQUEST' });
    }
  });
});
