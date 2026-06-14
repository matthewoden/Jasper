/**
 * Tests for McpGrantIndicator.
 *
 * Coverage: Tier-1 renders Sparkles + correct tooltip/attrs, no badge dot;
 * Tier-2 adds badge dot with --color-ai-grant-strong token; selector contract
 * (data-testid + data-grant-tier) passes.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { McpGrantIndicator } from "./McpGrantIndicator";

describe("McpGrantIndicator", () => {
  it("I1: Tier 1 — Sparkles, tooltip 'Edit only', no badge dot", () => {
    const { container, getByTestId } = render(<McpGrantIndicator level={1} />);

    const wrapper = getByTestId("mcp-grant-indicator");
    expect(wrapper).toBeTruthy();
    expect(wrapper.getAttribute("data-grant-tier")).toBe("1");
    expect(wrapper.getAttribute("title")).toBe("AI access: Edit only");
    expect(wrapper.getAttribute("aria-label")).toBe("AI access: Edit only");

    const svg = container.querySelector("svg");
    expect(svg).toBeTruthy();

    const badge = wrapper.querySelector("span[aria-hidden='true']");
    expect(badge).toBeNull();
  });

  it("I2: Tier 2 — Sparkles + badge dot; tooltip 'Full'", () => {
    const { container, getByTestId } = render(<McpGrantIndicator level={2} />);

    const wrapper = getByTestId("mcp-grant-indicator");
    expect(wrapper.getAttribute("data-grant-tier")).toBe("2");
    expect(wrapper.getAttribute("title")).toBe("AI access: Full");
    expect(wrapper.getAttribute("aria-label")).toBe("AI access: Full");

    expect(container.querySelector("svg")).toBeTruthy();

    const badge = wrapper.querySelector("span[aria-hidden='true']");
    expect(badge).toBeTruthy();
  });

  it("I3: Tier 2 badge uses --color-ai-grant-strong token", () => {
    const { getByTestId } = render(<McpGrantIndicator level={2} />);
    const wrapper = getByTestId("mcp-grant-indicator");
    const badge = wrapper.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(badge).toBeTruthy();
    expect(badge.style.background).toContain("--color-ai-grant-strong");
    expect(badge.style.border).toContain("--color-surface");
  });

  it("I4: data-testid is exactly 'mcp-grant-indicator' (selector contract)", () => {
    const { getByTestId } = render(<McpGrantIndicator level={1} />);
    expect(getByTestId("mcp-grant-indicator")).toBeTruthy();
  });
});
