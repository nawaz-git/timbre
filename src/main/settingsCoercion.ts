/**
 * Pure coercion helpers for the diarization-quality settings.
 *
 * Extracted from `settings.ts` (which imports electron) so the
 * read-back/round-trip validation can run under `node --test`. Each takes an
 * untrusted stored value and returns a safe, in-range setting — a stale or
 * garbage value can never force a mode or language.
 */
import { ASR_LANGUAGES } from '../shared/types'
import type { ProcessingMode } from '../shared/types'

/** Anything that isn't the explicit `max` opt-in defaults to `fast`. */
export function coerceProcessingMode(raw: unknown): ProcessingMode {
  return raw === 'max' ? 'max' : 'fast'
}

/**
 * Accept only a known ISO code (or the empty auto-detect sentinel); anything
 * else falls back to auto so a stale/garbage value can't force a language.
 */
export function coerceAsrLanguage(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return ASR_LANGUAGES.some((l) => l.code === raw) ? raw : ''
}
