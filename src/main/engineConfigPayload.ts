/**
 * Pure builder for the `engine_config.json` bridge payload.
 *
 * Deliberately electron-free (only the `Settings` type is imported) so the
 * bridge schema can be snapshot-tested with `node --test` — the same
 * separation `engineTranscript.ts` uses. The electron-side writer
 * (`engineConfig.ts`) imports this and adds `updatedAt` + the atomic write.
 */
import type { Settings } from '../shared/types'

/**
 * Build the bridge payload (minus `updatedAt`). Side-effect-free: the caller
 * injects the resolved global-speakers DB path. The `'auto'` num-speakers hint
 * maps to 0 (the engine's auto-detect sentinel). The engine-override field is
 * intentionally omitted (no Timbre control) — the engine falls back to its own
 * default when a key is absent. `llmRepair` is nested to match the engine's
 * `{ enabled }` shape.
 */
export function buildEngineConfigPayload(
  settings: Settings,
  globalDBPath: string
): Record<string, unknown> {
  return {
    screenCaptureScope: settings.screenCaptureScope,
    disableAppAudioTap: settings.disableAppAudioTap,
    processingMode: settings.processingMode,
    asrLanguage: settings.asrLanguage,
    numSpeakersHint: typeof settings.numSpeakers === 'number' ? settings.numSpeakers : 0,
    globalSpeakersDBPath: globalDBPath,
    llmRepair: { enabled: settings.llmRepair === true }
  }
}
