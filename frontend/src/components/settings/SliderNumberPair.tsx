/**
 * SliderNumberPair — a range and a number input over one value (SET3-07).
 * Dragging restyles live via a CSS custom property but commits ONCE, on
 * pointer-up. The number half enforces the real validator bounds, which may be
 * wider than the slider's comfortable range.
 *
 * Keyboard commits are debounced because arrow-key auto-repeat would otherwise
 * fire one PATCH per key event.
 */
import { useEffect, useRef, useState } from "react";
import { inputStyle } from "./shared";

const KEY_COMMIT_DEBOUNCE_MS = 250;

export interface SliderNumberPairProps {
  id: string;
  label: string;
  value: number;
  sliderMin: number;
  sliderMax: number;
  numberMin: number;
  numberMax: number;
  step: number;
  unit: string;
  cssVar: string;
  formatCssValue: (value: number) => string;
  onCommit: (value: number) => void;
  error?: string | null;
  /** id of the ControlRow caption stating the real validator bounds; applied
   *  to BOTH halves so either focus target announces them. */
  describedBy?: string;
}

export function SliderNumberPair({
  id,
  label,
  value,
  sliderMin,
  sliderMax,
  numberMin,
  numberMax,
  step,
  unit,
  cssVar,
  formatCssValue,
  onCommit,
  error,
  describedBy,
}: SliderNumberPairProps) {
  const [sliderValue, setSliderValue] = useState(value);
  const [numberInput, setNumberInput] = useState(String(value));
  const [localError, setLocalError] = useState<string | null>(null);
  const keyCommitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCommitRef = useRef<number | null>(null);
  const onCommitRef = useRef(onCommit);
  onCommitRef.current = onCommit;
  // Held in a ref, deliberately out of the sync effect's deps: the formatter
  // only derives a string from `value`, so a fresh inline arrow from the
  // parent must not re-run a *reset* effect that would wipe in-progress
  // number input and clear the validation alert.
  const formatCssValueRef = useRef(formatCssValue);
  formatCssValueRef.current = formatCssValue;

  // A failed save reverts `value`; roll the live CSS var and both inputs back
  // in step so the preview never lags behind the persisted config.
  useEffect(() => {
    setSliderValue(value);
    setNumberInput(String(value));
    setLocalError(null);
    document.documentElement.style.setProperty(cssVar, formatCssValueRef.current(value));
  }, [value, cssVar]);

  // FLUSH a pending commit on unmount, never drop it: the value is already
  // applied to the document as a whole-app restyle, so dropping the write leaves
  // the app rendering something the persisted config does not have.
  //
  // Deliberately unguarded by a value-unchanged check — the [] deps would make
  // that read a stale first-render closure. Worst case is one redundant PATCH.
  useEffect(() => {
    return () => {
      if (keyCommitTimer.current) clearTimeout(keyCommitTimer.current);
      if (pendingCommitRef.current !== null) {
        onCommitRef.current(pendingCommitRef.current);
      }
    };
  }, []);

  const handleRangeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    setSliderValue(next);
    setNumberInput(String(next));
    document.documentElement.style.setProperty(cssVar, formatCssValue(next));
  };

  // Never write an unchanged value: covers a click-without-drag pointerUp
  // and an arrow-key excursion that lands back on the starting value.
  const commitSlider = () => {
    if (sliderValue === value) return;
    onCommit(sliderValue);
  };

  // Pointer-driven commit stays immediate (commit on pointer-up).
  // Cancel any pending debounced keyboard commit so a drag right after a
  // key press can't double-fire.
  const handlePointerUpCommit = () => {
    if (keyCommitTimer.current) {
      clearTimeout(keyCommitTimer.current);
      keyCommitTimer.current = null;
      pendingCommitRef.current = null;
    }
    commitSlider();
  };

  // Keyboard-driven commit is debounced: each key event reschedules the
  // commit rather than firing immediately, so auto-repeat/rapid presses
  // coalesce into the single trailing commit once input settles.
  const handleKeyUpCommit = () => {
    if (keyCommitTimer.current) clearTimeout(keyCommitTimer.current);
    pendingCommitRef.current = sliderValue;
    keyCommitTimer.current = setTimeout(() => {
      keyCommitTimer.current = null;
      pendingCommitRef.current = null;
      commitSlider();
    }, KEY_COMMIT_DEBOUNCE_MS);
  };

  const handleNumberChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setNumberInput(e.target.value);
    setLocalError(null);
  };

  const commitNumber = () => {
    const next = Number(numberInput);
    if (!Number.isFinite(next) || next < numberMin || next > numberMax) {
      const unitSuffix = unit ? ` ${unit}` : "";
      setLocalError(
        `${label} must be between ${numberMin} and ${numberMax}${unitSuffix}. Reverted to previous value.`,
      );
      setNumberInput(String(value));
      return;
    }
    setLocalError(null);
    // Never write an unchanged value: a corrected-back-to-current entry must
    // still clear the alert (above), but must not issue a write.
    if (next === value) return;
    setSliderValue(next);
    document.documentElement.style.setProperty(cssVar, formatCssValue(next));
    onCommit(next);
  };

  const displayedError = localError ?? error;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="range"
          aria-label={label}
          aria-describedby={describedBy}
          min={sliderMin}
          max={sliderMax}
          step={step}
          value={sliderValue}
          onChange={handleRangeChange}
          onPointerUp={handlePointerUpCommit}
          onKeyUp={handleKeyUpCommit}
          style={{ accentColor: "var(--color-accent)", flex: 1 }}
        />
        <input
          id={id}
          type="number"
          min={numberMin}
          max={numberMax}
          step={step}
          aria-label={label}
          aria-describedby={describedBy}
          value={numberInput}
          onChange={handleNumberChange}
          onBlur={commitNumber}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitNumber();
          }}
          style={{ ...inputStyle, width: 72 }}
        />
        <span
          data-testid={`${id}-unit`}
          style={{ fontSize: 14, color: "var(--color-muted)", width: 24, flexShrink: 0 }}
        >
          {unit}
        </span>
      </div>
      {displayedError && (
        <span role="alert" style={{ fontSize: 12, color: "var(--color-destructive)" }}>
          {displayedError}
        </span>
      )}
    </div>
  );
}
