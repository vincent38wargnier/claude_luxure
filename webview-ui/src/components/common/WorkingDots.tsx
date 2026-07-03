/**
 * The panel's single "working" indicator: three dots with a soft staggered
 * opacity pulse (styles in index.css). Replaces the bouncing typing-dots —
 * calm, and it freezes under prefers-reduced-motion.
 */
export default function WorkingDots({ color = "#f59e0b" }: { color?: string }) {
  return (
    <span className="working-dots shrink-0" aria-hidden="true">
      <span style={{ backgroundColor: color }} />
      <span style={{ backgroundColor: color }} />
      <span style={{ backgroundColor: color }} />
    </span>
  );
}
