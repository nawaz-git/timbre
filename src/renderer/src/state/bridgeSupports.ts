/**
 * Compile-time flags for engine-bridge capabilities the UI depends on.
 *
 * A control is shown ONLY when the engine actually honours the setting it
 * writes. Otherwise Timbre would present a knob that does nothing, which
 * breaks the product's first principle — the status never lies. Flip a flag
 * to `true` in the SAME change that lands the engine-side support, so the
 * control and its effect appear together.
 */
export const bridgeSupports = {
  /**
   * The engine ACTS on `engine_config.json.processingMode` — i.e. picking
   * "Best" produces a measurably more accurate transcript than "Fast".
   * The field is already written and parsed, but the max-quality pipeline
   * isn't wired to consume it yet, so the two tiers currently produce
   * identical output. Keep this `false` until that consumption lands; then
   * the Processing → Transcription quality control becomes visible.
   */
  processingMode: false,
  /**
   * The engine can write live recordings to a user-chosen root
   * (`engine_config.json.outputRoot`). Until then the library lives at the
   * fixed `~/Downloads/MeetingTranscriber`, so Settings ships only the
   * transparency pieces (path + usage) and hides the "Move recordings…"
   * action. Flip to `true` when the engine honours a root override.
   */
  outputRoot: false
} as const
