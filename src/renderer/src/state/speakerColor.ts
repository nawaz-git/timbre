/**
 * Single source of truth for speaker colours.
 *
 * Maps a speaker name to one of twelve muted, tokenised hues
 * (`--speaker-1..12`, defined per-mode in theme.css) and returns a
 * `var(--speaker-N)` reference so the colour follows the active theme
 * (desaturated pastels in dark, deeper tones in light). Used as both a
 * `background` (pills, dots, the seek speaker-track) and a `color`
 * (transcript speaker labels).
 *
 * Replaces the two former local `SPEAKER_PALETTE` copies in Meetings.tsx
 * and SpeakerPicker.tsx — the saturated one-offs the token layer pulled in
 * for visual coherence. The name hash is unchanged from those copies so a
 * given speaker resolves deterministically; only the palette (and its
 * length, 6 → 12) changed.
 */
const SPEAKER_COLOR_COUNT = 12

export function colorForSpeaker(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0
  }
  return `var(--speaker-${(h % SPEAKER_COLOR_COUNT) + 1})`
}
