// A wizard hat, drawn to match lucide's stroke style (24 viewBox, currentColor).
// Lucide ships no wizard icon, so this is a small hand-made one.
export function WizardIcon({
  size = 16,
  className,
}: {
  size?: number | string;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {/* hat cone */}
      <path d="M12 2.5 8 15.5h8L12 2.5Z" />
      {/* brim */}
      <path d="M4.5 18.5c2.2-2.2 12.8-2.2 15 0-2.2 2.2-12.8 2.2-15 0Z" />
      {/* star on the hat */}
      <path
        d="M12 7.2c.35 1.1.7 1.45 1.8 1.8-1.1.35-1.45.7-1.8 1.8-.35-1.1-.7-1.45-1.8-1.8 1.1-.35 1.45-.7 1.8-1.8Z"
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}
