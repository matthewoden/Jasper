/**
 * TypePreviewPanel — live type-preview card for the Appearance pane (SET3-07,
 * D-25). Renders exactly one reading-font paragraph so a font-size/line-height
 * drag has an immediate, mid-drag visual payoff without waiting on a config
 * write. No heading, list, or excerpt of the open note — this is a fixed
 * sample sentence, not a live document render.
 */
import { Eyebrow } from "./shared";

export interface TypePreviewPanelProps {
  fontSize: number;
  lineHeight: number;
}

export function TypePreviewPanel({ fontSize, lineHeight }: TypePreviewPanelProps) {
  return (
    <div
      style={{
        border: "1px solid var(--color-border)",
        background: "var(--color-surface)",
        borderRadius: 8,
        padding: 16,
      }}
    >
      <Eyebrow text="Preview" />
      <p
        style={{
          margin: 0,
          fontFamily: "var(--font-reading)",
          fontSize: `${fontSize}px`,
          lineHeight,
          color: "var(--color-fg)",
        }}
      >
        Type styling applies instantly across every open note. Links like{" "}
        <span style={{ color: "var(--color-accent)" }}>Project Atlas</span> and tags like{" "}
        <span style={{ color: "var(--color-accent)" }}>#planning</span> follow the accent color.
      </p>
    </div>
  );
}
