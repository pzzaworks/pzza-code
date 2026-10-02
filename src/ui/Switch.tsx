// Compact on/off toggle used by settings rows.
export function Switch({ on, onToggle, title, small }: { on: boolean; onToggle: () => void; title: string; small?: boolean }) {
  return (
    <button
      type="button"
      className={`switch ${on ? "switch-on" : ""} ${small ? "switch-sm" : ""}`}
      role="switch"
      aria-checked={on}
      title={title}
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}
