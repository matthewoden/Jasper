/**
 * SliderNumberPair — paired <input type="range"> + <input type="number">
 * bound to one value (SET3-07). Dragging the slider restyles live via a CSS
 * custom property but commits to the network exactly once, on pointer-up /
 * key-up (D-26). The number half enforces the real validator bounds
 * (numberMin/numberMax), which may be wider than the slider's comfortable
 * sub-range (D-27).
 */
import { useEffect, useState } from "react";
import { inputStyle } from "./shared";

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
}: SliderNumberPairProps) {
  const [sliderValue, setSliderValue] = useState(value);
  const [numberInput, setNumberInput] = useState(String(value));
  const [localError, setLocalError] = useState<string | null>(null);

  // A failed save reverts `value`; roll the live CSS var and both inputs back
  // in step so the preview never lags behind the persisted config.
  useEffect(() => {
    setSliderValue(value);
    setNumberInput(String(value));
    setLocalError(null);
    document.documentElement.style.setProperty(cssVar, formatCssValue(value));
  }, [value, cssVar, formatCssValue]);

  const handleRangeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const next = Number(e.target.value);
    setSliderValue(next);
    setNumberInput(String(next));
    document.documentElement.style.setProperty(cssVar, formatCssValue(next));
  };

  const commitSlider = () => {
    onCommit(sliderValue);
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
          min={sliderMin}
          max={sliderMax}
          step={step}
          value={sliderValue}
          onChange={handleRangeChange}
          onPointerUp={commitSlider}
          onKeyUp={commitSlider}
          style={{ accentColor: "var(--color-accent)", flex: 1 }}
        />
        <input
          id={id}
          type="number"
          min={numberMin}
          max={numberMax}
          step={step}
          aria-label={label}
          value={numberInput}
          onChange={handleNumberChange}
          onBlur={commitNumber}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitNumber();
          }}
          style={{ ...inputStyle, width: 72 }}
        />
        {unit && <span style={{ fontSize: 14, color: "var(--color-muted)" }}>{unit}</span>}
      </div>
      {displayedError && (
        <span role="alert" style={{ fontSize: 12, color: "var(--color-destructive)" }}>
          {displayedError}
        </span>
      )}
    </div>
  );
}
