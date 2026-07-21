/**
 * Phase 23 UAT — Design Parity Fixes (P1 sidebar/section-header + note-title
 * sweep item).
 *
 * PARITY-02: the right rail (Outline / Linked mentions / Tags) has a 1px
 *   left border separating it from the editor; right-rail section-header
 *   labels render uppercase with 0.05em letter-spacing.
 * PARITY-03: the note title has -0.012em letter-spacing (sweep item).
 *
 * Harness mirrors phase21-uat.spec.ts: spawnJasper() per describe block
 * against a rebuilt binary, real page interactions, @phase23 tag.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll — never page.waitForTimeout. All three probes assert
 * on the rendered DOM node (never an ancestor that merely declares the
 * property without inheritance reaching descendants).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a note via the API; returns its UUID. */
async function createNote(jasper: JasperHandle, title: string): Promise<string> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: "", title }),
  });
  if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
  return ((await resp.json()) as { id: string }).id;
}

/** Set a note's body content via the API (no If-Match — force write). */
async function setNoteContent(
  jasper: JasperHandle,
  id: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) throw new Error(`set content ${id}: ${resp.status}`);
}

test.describe("@phase23 design parity fixes", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-rail border: the RightRail <aside> computes a 1px solid left border", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await waitForConnected(page, jasper.baseURL);

    // The resize-handle separator is a stable child of the rail <aside>
    // (only rendered while backlinksRailExpanded, true by default — D-06).
    // Its parent element IS the rendered rail node the border lives on.
    const railHandle = page.getByRole("separator", { name: "Resize backlinks panel" });
    await expect(railHandle).toBeVisible({ timeout: 10_000 });
    const rail = railHandle.locator("..");

    await expect
      .poll(() => rail.evaluate((el) => getComputedStyle(el).borderLeftWidth))
      .toBe("1px");
    await expect
      .poll(() => rail.evaluate((el) => getComputedStyle(el).borderLeftStyle))
      .toBe("solid");
  });

  test("section header: a right-rail sub-header label renders uppercase with letter-spacing", async ({
    page,
  }) => {
    // The clickable SectionHeader ("Collapse Outline panel" button, with
    // its own chevron/aria-expanded collapse state) this test originally
    // targeted was REMOVED in the Phase 30 TAGS-01 tab-row rework — panels
    // are no longer independently collapsible (RightRail.tsx header
    // comment: "that machinery has no analog in the one-panel-at-a-time tab
    // model and has been removed entirely"). Its current equivalent is
    // RightRailSubHeader (RightRailTabRow.tsx): a non-clickable div with a
    // label <span> — chevron/onToggle/aria-expanded machinery explicitly
    // stripped (ported "verbatim from SectionHeader.tsx" minus that piece).
    // The uppercase + letter-spacing styling this test guards survived the
    // rework unchanged (subHeaderLabelStyle).
    await page.setViewportSize({ width: 1512, height: 944 });
    await waitForConnected(page, jasper.baseURL);

    // Outline is the rightPanel default (RIGHT_PANEL_DEFAULT), so its
    // sub-header is always present when the rail is expanded (D-06
    // default), independent of any open note.
    const label = page.locator("span").filter({ hasText: /^Outline$/ });
    await expect(label).toBeVisible({ timeout: 10_000 });

    // Confirm it's the non-clickable sub-header, not wrapped in a button —
    // the Phase 20 collapse affordance is gone.
    await expect(page.getByRole("button", { name: "Collapse Outline panel" })).toHaveCount(0);

    await expect
      .poll(() => label.evaluate((el) => getComputedStyle(el).textTransform))
      .toBe("uppercase");
    await expect
      .poll(() => label.evaluate((el) => getComputedStyle(el).letterSpacing))
      .not.toBe("normal");
  });

  test("note title: the note-title element computes a non-normal (negative-tracking) letter-spacing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await createNote(jasper, "title-tracking-note");
    await setNoteContent(
      jasper,
      noteId,
      "# title-tracking-note\n\nBody text so the note has content.\n",
    );
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    const titleEl = page.getByTestId("editor-title-element");
    await expect(titleEl).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(() => titleEl.evaluate((el) => getComputedStyle(el).letterSpacing))
      .not.toBe("normal");
  });
});
