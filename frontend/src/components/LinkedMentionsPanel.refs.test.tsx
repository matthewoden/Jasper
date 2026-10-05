import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/usePaneStore", () => ({
  usePaneStore: { getState: () => ({ openInActivePane: vi.fn() }) },
}));
vi.mock("../lib/sanitize", () => ({ sanitizeHtml: (s: string) => s }));

import { LinkedMentionsPanel, groupForeignRefs } from "./LinkedMentionsPanel";
import type { NoteRef } from "../lib/itemsApi";

const REFS: NoteRef[] = [
  { target_ref: "jasper:note/01ARZ3NDEKTSV4RRFFQ69G5FAV", display: "", embed: false, position: 10 },
  { target_ref: "bt:task/9", display: "", embed: false, position: 20 },
  { target_ref: "ado:workitem/12345", display: "the ticket", embed: false, position: 30 },
  { target_ref: "ado:workitem/7", display: "", embed: false, position: 40 },
  { target_ref: "jasper:title/Nowhere", display: "", embed: false, position: 50 },
];

describe("groupForeignRefs", () => {
  it("drops native refs and groups the rest by namespace, alphabetically", () => {
    const groups = groupForeignRefs(REFS);
    expect(groups.map(([ns, rows]) => [ns, rows.map((r) => r.target_ref)])).toEqual([
      ["ado", ["ado:workitem/12345", "ado:workitem/7"]],
      ["bt", ["bt:task/9"]],
    ]);
    expect(groupForeignRefs(null)).toEqual([]);
  });
});

describe("LinkedMentionsPanel foreign references", () => {
  it("lists foreign refs raw under their namespace, beside the backlinks", () => {
    render(
      <LinkedMentionsPanel
        noteId="01ARZ3NDEKTSV4RRFFQ69G5FAV"
        backlinks={[]}
        loading={false}
        error={null}
        refs={REFS}
      />,
    );
    const section = screen.getByTestId("foreign-refs");
    expect(section).toHaveTextContent("Foreign references");
    expect(section).toHaveTextContent("ado");
    expect(section).toHaveTextContent("ado:workitem/12345");
    expect(section).toHaveTextContent("the ticket");
    expect(section).toHaveTextContent("bt:task/9");
    expect(section).not.toHaveTextContent("jasper:");
    expect(screen.queryByText("No backlinks found")).toBeNull();
  });

  it("keeps the empty state when there are neither backlinks nor foreign refs", () => {
    render(
      <LinkedMentionsPanel noteId="01ARZ3NDEKTSV4RRFFQ69G5FAV" backlinks={[]} loading={false} error={null} refs={[REFS[0]]} />,
    );
    expect(screen.getByText("No backlinks found")).toBeInTheDocument();
    expect(screen.queryByTestId("foreign-refs")).toBeNull();
  });
});
