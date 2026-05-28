/**
 * Inline pencil glyph used by the meeting-list rename affordance.
 *
 * Stroke-only (no fill) so the icon reads cleanly in both dark and light
 * themes against `currentColor`. Sized to 16px by default — wrap in a 24×24
 * button to get a comfortable hit target.
 */
export function PencilIcon({ size = 16 }: { size?: number }): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  )
}
