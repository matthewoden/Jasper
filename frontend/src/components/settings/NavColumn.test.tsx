import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NavColumn } from "./NavColumn";
import type { SectionId } from "./sections";

function renderNav(overrides: Partial<React.ComponentProps<typeof NavColumn>> = {}) {
  const onSelect = vi.fn();
  render(
    <NavColumn
      activeSection="appearance"
      onSelect={onSelect}
      vaultName="my-vault"
      appVersion="1.4.0"
      {...overrides}
    />,
  );
  return { onSelect };
}

describe("NavColumn", () => {
  it("renders exactly four nav rows", () => {
    renderNav();
    // Scoped to the <nav>: an unscoped query would also count a future
    // footer action and fail with a misleading "nav rows" message.
    expect(within(screen.getByRole("navigation")).getAllByRole("button")).toHaveLength(4);
  });

  it("does not render a Templates row", () => {
    renderNav();
    expect(screen.queryByRole("button", { name: /Templates/i })).toBeNull();
  });

  it("does not render a Server row", () => {
    renderNav();
    expect(screen.queryByRole("button", { name: /Server/i })).toBeNull();
  });

  it("calls onSelect with the section id when a row is clicked", () => {
    const { onSelect } = renderNav();
    fireEvent.click(screen.getByRole("button", { name: /Editor/ }));
    expect(onSelect).toHaveBeenCalledWith("editor" as SectionId);
  });

  it("marks only the active row with aria-current=page", () => {
    renderNav({ activeSection: "editor" });
    const editorButton = screen.getByRole("button", { name: /Editor/ });
    const appearanceButton = screen.getByRole("button", { name: /Appearance/ });
    expect(editorButton).toHaveAttribute("aria-current", "page");
    expect(appearanceButton).not.toHaveAttribute("aria-current");
  });

  it("renders a 216px-wide column", () => {
    const { container } = render(<NavColumn activeSection="appearance" onSelect={vi.fn()} />);
    expect(container.firstChild).toHaveStyle({ width: "216px" });
  });
});
