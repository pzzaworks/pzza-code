import "./Segmented.css";

// A compact choice between a few options, shown side by side as a radio group.
export function Segmented<T extends string | number>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: readonly { value: T; label: string }[];
  onChange(value: T): void;
  ariaLabel: string;
}) {
  return <div className="segmented" role="radiogroup" aria-label={ariaLabel}>
    {options.map((option) => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
      className={`segmented-option${option.value === value ? " segmented-on" : ""}`} onClick={() => onChange(option.value)}>
      {option.label}
    </button>)}
  </div>;
}
