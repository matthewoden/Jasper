/**
 * Phase 20 UAT — Right Sidebar: Outline & Linked Mentions.
 *
 * RSIDE-01: the Outline panel parses headings from the LIVE CM6 document,
 *   indents rows by heading level (8 + (level-1)*12 px per 20-UI-SPEC.md),
 *   includes the title-bound first H1, shows "No headings" when a note has
 *   none, and a row click smooth-scrolls (CSS `scroll-behavior: smooth` on
 *   `.cm-scroller`) + moves the cursor to that heading line (D-13).
 * RSIDE-02: Linked mentions renders one card per linking note (accent title,
 *   `useTabStore.getState().openTab` on click — D-15), stacked per-mention
 *   excerpts (D-16/D-17), and "No backlinks found" when there are none
 *   (D-19). The header count badge (D-18) was dropped in Phase 31
 *   (D-01/D-02) along with all right-rail sub-headers — no longer asserted.
 * Chrome model (D-01..D-07): the tab-bar toggle is the sidebar's only
 *   show/hide control; the rail is visible by default on a fresh profile.
 *   The three sections (Outline / Linked mentions / Tags) are now exactly
 *   one mounted panel at a time, switched via the icon tab row (Phase 30
 *   TAGS-01 rework; superseded the original independent SectionHeaders).
 *
 * Harness mirrors phase19-uat.spec.ts: spawnJasper() per describe block
 * against a rebuilt binary (`make build` — see task verify command), real
 * page.mouse/click interactions (never synthetic events), @phase20 tag.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion (scroll
 * settling, WS-driven backlinks refetch, section collapse) uses
 * expect/expect.poll — never page.waitForTimeout.
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

function tabStrip(page: Page) {
  return page.getByTestId("tab-strip");
}

function tabPills(page: Page) {
  return tabStrip(page).getByRole("tab");
}

function outlineHeadingRow(page: Page, text: string) {
  return page.getByRole("button", { name: `Go to heading: ${text}`, exact: true });
}

function outlineList(page: Page) {
  return page.getByRole("group", { name: "Note outline" });
}

/**
 * Right-rail icon-tab row (Phase 30 TAGS-01 rework — replaces the Phase 20
 * three-collapsible-sections rail). Exactly one panel is mounted at a time,
 * selected by clicking one of these three icon-only tab buttons.
 */
function railTabRow(page: Page) {
  return page.getByTestId("right-rail-tab-row");
}

function railTab(page: Page, name: "Outline" | "Linked mentions" | "Tags") {
  return railTabRow(page).getByRole("button", { name });
}

async function repeatLines(n: number, text: string): Promise<string> {
  return Array.from({ length: n }, (_, i) => `${text} ${i + 1}`).join("\n\n") + "\n";
}

// ─── RSIDE-01: Outline — indent by level, click smooth-scroll, empty state ──

test.describe("@phase20 RSIDE-01: Outline lists headings indented by level, first H1 included", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("outline rows appear in document order with increasing left indent per heading level", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "outline-note");
    const filler = await repeatLines(6, "filler paragraph text");
    await setNoteContent(
      jasper,
      noteId,
      `# outline-note\n\n${filler}\n## Section Two\n\n${filler}\n### Section Three\n\nmore text\n`,
    );

    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    await expect(outlineList(page)).toBeVisible({ timeout: 10_000 });

    const h1Row = outlineHeadingRow(page, "outline-note");
    const h2Row = outlineHeadingRow(page, "Section Two");
    const h3Row = outlineHeadingRow(page, "Section Three");
    await expect(h1Row).toBeVisible();
    await expect(h2Row).toBeVisible();
    await expect(h3Row).toBeVisible();

    // Document order.
    const allRows = page.getByRole("button", { name: /^Go to heading:/ });
    await expect(allRows).toHaveCount(3);
    expect((await allRows.allTextContents()).map((t) => t.trim())).toEqual([
      "outline-note",
      "Section Two",
      "Section Three",
    ]);

    // Indent increases strictly per level (8 + (level-1)*12 px per 20-UI-SPEC.md).
    const indentOf = async (loc: ReturnType<typeof outlineHeadingRow>) =>
      await loc.evaluate((el) => parseFloat(getComputedStyle(el).paddingLeft));
    const [i1, i2, i3] = await Promise.all([
      indentOf(h1Row),
      indentOf(h2Row),
      indentOf(h3Row),
    ]);
    expect(i1).toBe(8);
    expect(i2).toBe(20);
    expect(i3).toBe(32);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
  });

  test("clicking a heading smooth-scrolls the editor so that heading's line settles near the top", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "scroll-note");
    // Filler both BEFORE and AFTER the target heading: the browser clamps
    // scrollTop to the document's max scrollable range, so a heading with
    // insufficient TRAILING content behind it can never reach the "y:start"
    // top-margin position (it settles wherever the clamp lands instead) —
    // this is a real constraint of the browser's scroll model, not something
    // the smooth-scroll implementation can special-case around. Enough
    // filler after the target guarantees the assertion below reflects the
    // actual scroll-to-heading behavior rather than an end-of-document clamp.
    const before = await repeatLines(60, "leading filler line to force scrolling");
    const after = await repeatLines(60, "trailing filler line to keep the target off the last screenful");
    await setNoteContent(
      jasper,
      noteId,
      `# scroll-note\n\n${before}\n## Target Heading\n\n${after}`,
    );

    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);
    await expect(outlineList(page)).toBeVisible({ timeout: 10_000 });

    const scroller = page.locator(".cm-scroller").first();
    const initialScrollTop = await scroller.evaluate((el) => el.scrollTop);
    expect(initialScrollTop).toBe(0);

    await outlineHeadingRow(page, "Target Heading").click();

    // Poll for the eventual scrolled state (CSS scroll-behavior:smooth animates
    // over time, and CM6 may re-adjust the estimated jump once it measures the
    // newly-rendered viewport) — never a fixed sleep, never a "two-reads-equal"
    // plateau check (CM6's multi-step jump-then-remeasure can produce a
    // transient plateau that is NOT the final position). Poll directly on the
    // signal we actually care about: the clicked heading's line settling near
    // the top of the scroller (scrollIntoView y:"start", yMargin:40).
    const headingLine = page.locator(".cm-content:visible").getByText("Target Heading", { exact: false });
    await expect(headingLine.first()).toBeVisible({ timeout: 5_000 });

    await expect
      .poll(
        async () => {
          const scrollerBox = await scroller.boundingBox();
          const headingBox = await headingLine.first().boundingBox();
          if (!scrollerBox || !headingBox) return null;
          return headingBox.y - scrollerBox.y;
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(150);

    // The scroll genuinely moved (not a no-op) and the final position is
    // stable once more (confirms settling, now that we know it's the RIGHT
    // position — not a mid-animation or mid-remeasure coincidence).
    const finalScrollTop = await scroller.evaluate((el) => el.scrollTop);
    expect(finalScrollTop).toBeGreaterThan(300);
    await expect
      .poll(async () => await scroller.evaluate((el) => el.scrollTop), { timeout: 2_000 })
      .toBe(finalScrollTop);
  });

  test("a note with no headings shows the 'No headings' empty state", async ({ page }) => {
    const noteId = await createNote(jasper, "plain-note");
    await setNoteContent(jasper, noteId, "just some plain body text\nno heading markers at all\n");

    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    await expect(page.getByText("No headings", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByText("Add a heading to see it here.")).toBeVisible();
    await expect(outlineList(page)).toHaveCount(0);
  });
});

// ─── RSIDE-02: Linked mentions — cards, count badge, openTab, empty state ──

test.describe("@phase20 RSIDE-02: Linked-mentions cards, count badge, openTab, empty state", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("one card per linking note, accent title, stacked per-mention excerpts, count badge, click opens tab", async ({
    page,
  }) => {
    await createNote(jasper, "target-note");
    const linkingId = await createNote(jasper, "linking-note");
    await setNoteContent(
      jasper,
      linkingId,
      "# linking-note\n\nFirst mention here [[target-note]] about topic A.\n\nSecond mention here [[target-note]] about topic B.\n",
    );

    await waitForConnected(page, jasper.baseURL);
    const targetRow = page.locator('[data-tree-row-kind="note"]', { hasText: "target-note" });
    await expect(targetRow).toBeVisible({ timeout: 10_000 });
    await targetRow.click();

    // Linked mentions is not the default rail tab (Outline is) — switch to
    // it before asserting the panel's count badge/cards (Phase 30 TAGS-01
    // single-mounted-panel tab-row model).
    await railTab(page, "Linked mentions").click();

    // Panel-level counts (the sub-header's count badge) were dropped
    // entirely in Phase 31 (D-01/D-02) and do not relocate — only the
    // cards/openTab/excerpts behavior below remains in scope.
    const cardTitle = page.getByRole("button", { name: "Open note: linking-note" });
    await expect(cardTitle).toBeVisible();
    const titleColor = await cardTitle.evaluate((el) => getComputedStyle(el).color);
    expect(titleColor).toBe("rgb(167, 139, 250)"); // var(--color-accent) default #a78bfa

    const excerpts = page.locator(".backlinks-excerpt");
    await expect(excerpts).toHaveCount(2);
    await expect(excerpts.nth(0)).toContainText("topic A");
    await expect(excerpts.nth(1)).toContainText("topic B");

    await cardTitle.click();
    await expect(tabPills(page).filter({ hasText: "linking-note" })).toHaveCount(1, {
      timeout: 5_000,
    });
    const activeTab = page.getByRole("tab", { selected: true });
    await expect(activeTab).toHaveText(/linking-note/, { timeout: 5_000 });
  });

  test("'No backlinks found' when a note has no backlinks", async ({ page }) => {
    const noteId = await createNote(jasper, "lonely-note");

    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    // Explicit switch (not relying on tab persistence from a prior test in
    // this describe block) — Outline is the tab-row default.
    await railTab(page, "Linked mentions").click();

    await expect(page.getByText("No backlinks found", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(
      page.getByText("Notes that link here with [[wiki-links]] will appear here."),
    ).toBeVisible();
  });
});

// ─── Chrome model: default-visible rail + single-mounted-panel tab-row ──
//
// The Phase 20 three-collapsible-sections rail (independent SectionHeader
// aria-expanded state per section, all three stacked and visible at once)
// was REPLACED by the Phase 30 TAGS-01 tab-row rework (RightRail.tsx):
// exactly ONE panel (Outline / Linked mentions / Tags) is mounted at a
// time, selected by a 30x30 icon-tab row, with no per-section collapse
// affordance left anywhere in the rail. This test is rewritten to guard
// the current equivalent of the same user value this Phase 20 test
// protected — "the right rail renders by default and its panel-switching
// affordance works" — using the icon-tab row instead of section headers.
//
// NOTE for owner review: this now materially overlaps
// phase30-rail-uat.spec.ts's "TAGS-01" test, which already exercises the
// same single-mounted-panel tab-row contract (plus workspace.json
// persistence across reload). Consider retiring one of the two once
// confirmed redundant — left both in place per Rule 3 (no deletions
// without owner sign-off).
test.describe("@phase20 chrome: right rail visible by default; icon-tab row mounts exactly one panel at a time", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("the rail + all three icon tabs render on a fresh profile with no note open; each tab click mounts exactly that panel", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    await expect(railTabRow(page)).toBeVisible({ timeout: 10_000 });
    const outlineTab = railTab(page, "Outline");
    const mentionsTab = railTab(page, "Linked mentions");
    const tagsTab = railTab(page, "Tags");
    await expect(outlineTab).toBeVisible();
    await expect(mentionsTab).toBeVisible();
    await expect(tagsTab).toBeVisible();

    const outlinePanel = outlineList(page);
    const linkedPanel = page.getByRole("region", {
      name: "Notes that link to this note",
    });
    const tagsEmptyState = page.getByText("No tags in this vault");

    // Default tab: Outline — "No headings" empty state (no note open yet).
    await expect(page.getByText("No headings", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await expect(linkedPanel).not.toBeVisible();
    await expect(tagsEmptyState).not.toBeVisible();

    await mentionsTab.click();
    await expect(linkedPanel).toBeVisible({ timeout: 5_000 });
    await expect(outlinePanel).toHaveCount(0);
    await expect(tagsEmptyState).not.toBeVisible();

    await tagsTab.click();
    await expect(tagsEmptyState).toBeVisible({ timeout: 5_000 });
    await expect(outlinePanel).toHaveCount(0);
    await expect(linkedPanel).not.toBeVisible();

    await outlineTab.click();
    await expect(page.getByText("No headings", { exact: true })).toBeVisible({
      timeout: 5_000,
    });
    await expect(linkedPanel).not.toBeVisible();
    await expect(tagsEmptyState).not.toBeVisible();
  });
});
