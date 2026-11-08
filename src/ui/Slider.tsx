import { useId, type CSSProperties } from "react";
import "./Slider.css";

// A range with its value at a fixed width beside it, so dragging never changes
// the row's text or makes it wrap.
// `snap` marks a value (the default) on the track and pulls the thumb onto it
// when released within `within` steps, so the default is easy to find again.
export function Slider({ label, min, max, value, unit = "%", format, valueText, disabled, snap, onChange }: {
  label: string; min: number; max: number; value: number; unit?: string; format?: (value: number) => string;
  valueText?: string; disabled?: boolean; snap?: { value: number; within: number }; onChange: (value: number) => void;
}) {
  const marks = useId();
  const shown = format ? format(value) : `${value}${unit}`;
  const settle = (next: number) => (snap && Math.abs(next - snap.value) <= snap.within ? snap.value : next);
  const ratio = (at: number) => (at - min) / Math.max(1, max - min);
  // The track fills up to the value; the mark sits under the default.
  const track = { "--fill": `${ratio(value) * 100}%`, ...(snap ? { "--mark-ratio": String(ratio(snap.value)) } : {}) } as CSSProperties;
  return <span className="set-slider">
    <span className="set-slider-track" style={track}>
      <input aria-label={label} type="range" min={min} max={max} step={1} value={value} disabled={disabled}
      list={snap ? marks : undefined} aria-valuetext={valueText ?? shown} onChange={(event) => onChange(settle(Number(event.target.value)))} />
      {snap ? <span className={`set-slider-mark ${value === snap.value ? "is-on" : ""}`} title="Default" aria-hidden="true" /> : null}
    </span>
    {snap ? <datalist id={marks}><option value={snap.value} label="Default" /></datalist> : null}
    <output className="set-slider-value" aria-hidden="true">{shown}</output>
  </span>;
}
