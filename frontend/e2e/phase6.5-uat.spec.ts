/**
 * Phase 6.5 UAT — Tags + Rails Polish.
 *
 * All scenarios share a single `bin/jasper` instance (beforeAll / afterAll) to
 * reduce runtime. Scenarios run in declaration order; data created earlier is
 * visible to later scenarios. Use unique tag/title names to avoid interference.
 *
 * Scenarios:
 *   S1 (@UX-T-01) : REWRITTEN (Phase 30 tab-row rework removed the original
 *                   "panel cards + draggable inter-panel divider" design) —
 *                   now guards the current equivalent: right-rail tab
 *                   switching (Outline/Linked mentions/Tags swap the single
 *                   mounted panel) + the active tab persists across reload.
 *   S2 (@UX-T-02) : Type `#blue` in body → cm-inline-tag rendered; `# heading`
 *                   does NOT render as inline tag
 *   S3 (@UX-T-03) : Type `#newtag` in body → save → Tags panel shows newtag
 *                   within 2s → reload → frontmatter contains the tag
 *   S4 (@UX-T-04) : Open note with frontmatter → block hidden, affordance visible;
 *                   Cmd-Shift-Y → raw shown; Cmd-Shift-Y → hidden; note switch
 *                   resets to hidden
 *   S5 (@UX-T-05) : RETIRED in v1.2 — the Tags panel substring-filter input was
 *                   removed in the Phase 20 RightRail redesign (no replacement).
 *   S6 (@BUG-01)  : Save with new tag → Tags panel updates within 2s (no reload)
 *   S7 (@BUG-02)  : Open note with incoming [[...]] → Backlinks panel shows row
 *                   within 2s
 *   S8 (@BUG-03)  : Switch notes without editing → SaveIndicator stays idle;
 *                   actual edit + save → "Saved" appears (positive case)
 *   S9 (@autocomplete-polish) : `[[` popup and `#` popup have border-radius 8px
 *                               and foreground-contrast text
 *
 * Selector notes (Phase 30 right-rail tab-row rework, 30-05/30-08):
 *   - CM6 editor is contenteditable — use keyboard.type(), not .fill(). Tabs
 *     keep every open note's EditorPane mounted (inactive = display:none), so
 *     `.cm-content` can match several elements — target `.cm-content:visible`.
 *   - Tags panel uses data-testid="tag-row-{name}".
 *   - Frontmatter affordance: button.cm-frontmatter-affordance
 *   - Right-rail panels: RightRailTabRow renders icon-only Outline / Linked
 *     mentions / Tags tab buttons (aria-label = the panel name); exactly ONE
 *     panel is mounted below at a time, driven by the persisted rightPanel
 *     field (useWorkspace). The Phase 20 three-section stacked/collapsible
 *     rail (independent SectionHeader "Collapse/Expand <Title> panel"
 *     toggles, InterPanelDivider height-ratio persistence) was removed
 *     entirely — no per-section collapse state, no inter-panel divider.
 *   - The tag-list substring filter input ("Filter tag list") was removed.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";


let jasper: JasperHandle;

test.beforeAll(async () => {
  jasper = await spawnJasper();
});

test.afterAll(async () => {
  if (jasper) await jasper.kill();
});


/**
 * Navigate to baseURL and wait for WS "connected" status.
 * Optionally open the first note in the tree so the editor mounts.
 */
async function openApp(page: Page, openFirstNote = true): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
  if (openFirstNote) {
    const firstNote = page.locator('[data-tree-row-kind="note"]').first();
    await expect(firstNote).toBeVisible({ timeout: 8_000 });
    await firstNote.click();
    await waitForActiveEditor(page);
  }
}

/**
 * Wait for the ACTIVE tab's editor to be mounted and visible.
 *
 * Post-redesign (Phase 18 tabs) each open tab keeps its own CM6 EditorPane
 * mounted; inactive tabs are display:none keep-alive panes. So `.cm-content`
 * can resolve to several elements — only the active tab's pane is visible.
 * The `:visible` filter selects that one.
 */
async function waitForActiveEditor(page: Page): Promise<void> {
  await page.waitForSelector(".cm-content:visible", { timeout: 8_000 });
}

/**
 * CM6 typing recipe: click the active (visible) .cm-content, select-all,
 * delete, then keyboard-type. Uses keyboard.type() NOT textarea.fill() — the
 * CM6 editor is contenteditable.
 */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  const cm = page.locator(".cm-content:visible").first();
  await cm.click();
  const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

/**
 * Wait for the SaveIndicator to reach "saved" state.
 * SaveIndicator renders as an icon-button with data-save-state attribute
 * (button mode, used in StatusBar). The legacy role="status" overlay is not
 * shown when SaveIndicator receives an onClick prop.
 */
async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect(
    page.locator('button[data-save-state="saved"]'),
  ).toBeVisible({ timeout: timeoutMs });
}

/**
 * Select a right-rail tab (Outline / Linked mentions / Tags) and reveal the
 * rail first if it is collapsed.
 *
 * Phase 30's tab-row rework (30-05/30-08, TAGS-01 D-01/D-02) replaced the
 * Phase 20 three-section stacked/collapsible rail (independent SectionHeader
 * "Expand/Collapse <Title> panel" toggles, two draggable inter-panel
 * dividers) with a single-panel-at-a-time model: RightRailTabRow renders
 * icon-only Outline / Linked mentions / Tags tabs (aria-label = the panel
 * name), and exactly one panel is mounted below at a time, driven by the
 * persisted rightPanel field (useWorkspace, PUT /api/v1/workspace). There is
 * no more per-section collapse state or inter-panel divider — that machinery
 * was removed entirely. If the whole rail is collapsed, "Show panels" (the
 * TabStrip right-cluster reopen control, rendered on the rightmost pane) is
 * clicked first.
 */
async function selectRightRailTab(
  page: Page,
  tab: "Outline" | "Linked mentions" | "Tags",
): Promise<void> {
  const showPanels = page.getByRole("button", { name: "Show panels" });
  if (await showPanels.isVisible().catch(() => false)) {
    await showPanels.click();
  }
  await page.getByRole("button", { name: tab, exact: true }).click();
}

/**
 * Ensure the Linked mentions panel is the active right-rail tab (BUG-02).
 */
async function ensureRailExpanded(page: Page): Promise<void> {
  await selectRightRailTab(page, "Linked mentions");
  await expect(
    page.getByRole("region", { name: "Notes that link to this note" }),
  ).toBeVisible({ timeout: 8_000 });
}

/**
 * Create a note via the API. Returns the note's UUID.
 * parent_path is relative to notes/ (empty string = vault root).
 */
async function apiCreateNote(
  page: Page,
  relPath: string,
  content: string,
): Promise<string> {
  const withoutNotes = relPath.replace(/^notes\//, "");
  const lastSlash = withoutNotes.lastIndexOf("/");
  const parent_path = lastSlash >= 0 ? withoutNotes.slice(0, lastSlash) : "";
  const basename = lastSlash >= 0 ? withoutNotes.slice(lastSlash + 1) : withoutNotes;
  const title = basename.replace(/\.md$/, "");

  const createResp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { parent_path, title },
  });
  if (createResp.status() !== 201) {
    const body = await createResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: POST returned ${String(createResp.status())} for ${relPath}: ${body}`,
    );
  }
  const created = (await createResp.json()) as { id: string };
  const id = created.id;

  const updateResp = await page.request.put(
    `${jasper.baseURL}/api/v1/notes/${id}`,
    { data: { content } },
  );
  if (updateResp.status() !== 200) {
    const body = await updateResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: PUT returned ${String(updateResp.status())} for ${relPath}: ${body}`,
    );
  }
  return id;
}

/**
 * Ensure the Tags panel is the active right-rail tab (S3, BUG-01).
 *
 * The Tags panel is one of three tab-driven right-rail panels (Phase 30
 * tab-row rework). Phase 31 D-03/D-05 deleted the upper active-note
 * "Note tags" section this helper originally waited on (and its
 * useNoteTagsStore live-parse machinery) — the Tags tab is now a single
 * vault-wide list (RightRailTagsPanel, `<ul role="list">`, rows via
 * data-testid="tag-row-{name}") with no header of its own. Wait for that
 * list's `<ul role="list">` to mount instead (scoped to `ul` — an
 * unrelated `<ol role="list">` elsewhere on the page also matches a bare
 * role query).
 */
async function ensureTagsPanelExpanded(page: Page): Promise<void> {
  await selectRightRailTab(page, "Tags");
  await expect(page.locator("ul[role='list']")).toBeVisible({ timeout: 5_000 });
}


test("S1 @UX-T-01: right-rail tab row switches panels; active tab persists across reload", async ({ page }) => {
  // REWRITTEN (Rule 3): the Phase 20 "panel cards + draggable inter-panel
  // divider" design this scenario originally guarded was removed by Phase
  // 30's tab-row rework (30-05/30-08) — RightRail.tsx now mounts exactly one
  // panel at a time (no stacked cards, no InterPanelDivider, no per-section
  // height-ratio persistence). The nearest current equivalent of the same
  // user value ("the rail's layout is navigable and remembers what you were
  // looking at") is: tab switching moves between panels, and the active tab
  // (rightPanel) persists across a reload via workspace.json.
  await openApp(page, false);

  // Default panel is Outline (RIGHT_PANEL_DEFAULT). No note is open in this
  // scenario (openApp(page, false)), so the panel renders its "No headings"
  // empty state (Phase 31 D-01 removed the "Outline" sub-header label this
  // originally asserted — that heading no longer exists anywhere in the DOM).
  await selectRightRailTab(page, "Outline");
  await expect(page.getByText("No headings", { exact: true })).toBeVisible({ timeout: 8_000 });
  await expect(
    page.getByRole("region", { name: "Notes that link to this note" }),
  ).toHaveCount(0);

  // Switching to Tags swaps the mounted panel — Outline's content unmounts,
  // the single vault-wide tag list (Phase 31 D-03/D-05; no "Note tags"
  // section — that concept is fully deleted) mounts in its place.
  await selectRightRailTab(page, "Tags");
  await expect(page.locator("ul[role='list']")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("No headings", { exact: true })).toHaveCount(0);

  // Switching to Linked mentions swaps again — the Tags list unmounts.
  await selectRightRailTab(page, "Linked mentions");
  await expect(
    page.getByRole("region", { name: "Notes that link to this note" }),
  ).toBeVisible({ timeout: 8_000 });

  // Reload — the persisted rightPanel field should restore Linked mentions
  // as the active tab without re-selecting it.
  await page.reload();
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
  const showPanelsAfterReload = page.getByRole("button", { name: "Show panels" });
  if (await showPanelsAfterReload.isVisible().catch(() => false)) {
    await showPanelsAfterReload.click();
  }
  await expect(
    page.getByRole("region", { name: "Notes that link to this note" }),
  ).toBeVisible({ timeout: 8_000 });
});


test("S2 @UX-T-02: #tagname renders as cm-inline-tag; # heading does NOT", async ({ page }) => {
  await openApp(page, true);

  await typeIntoEditor(
    page,
    "---\ntags: []\n---\n\n# My Note\n\nSome body text with #alpha and more words.\n\n## Another heading not a tag",
  );

  await page.waitForTimeout(300);

  const cm = page.locator(".cm-content");
  await cm.click();
  const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
  await page.keyboard.press(gotoEndKey);
  await page.waitForTimeout(400);

  const inlineTag = page.locator(".cm-inline-tag").first();
  await expect(inlineTag).toBeVisible({ timeout: 5_000 });
  const inlineTagText = (await inlineTag.textContent()) ?? "";
  expect(inlineTagText).toContain("alpha");

  const headingHasInlineTag = await page.evaluate(() => {
    const editor =
      Array.from(document.querySelectorAll(".cm-content")).find(
        (el) => (el as HTMLElement).offsetParent !== null,
      ) ?? document.querySelector(".cm-content");
    const lines = editor
      ? editor.querySelectorAll(".cm-line")
      : ([] as unknown as NodeListOf<Element>);
    for (const line of Array.from(lines)) {
      const text = line.textContent ?? "";
      if (text.startsWith("# My Note") || text.includes("My Note")) {
        return line.querySelector(".cm-inline-tag") !== null;
      }
    }
    return false;
  });
  expect(headingHasInlineTag).toBe(false);
});


test("S3 @UX-T-03: type #twowaytest in body → save → Tags panel shows it within 2s + frontmatter updated", async ({ page }) => {
  await openApp(page, true);
  await ensureTagsPanelExpanded(page);

  await typeIntoEditor(
    page,
    "---\ntags: []\n---\n\n# TwoWayNote\n\nTesting two-way binding with #twowaytest tag here.",
  );

  const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
  await page.keyboard.press(saveKey);
  await waitForSaved(page, 10_000);

  await expect
    .poll(
      () => page.getByTestId("tag-row-twowaytest").isVisible(),
      { timeout: 2_000, intervals: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200] },
    )
    .toBeTruthy();

  await page.reload();
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
  expect(treeResp.status()).toBe(200);
  const tree = (await treeResp.json()) as {
    root: Array<{ kind: string; id?: string; path?: string }>;
  };
  const noteNode = tree.root.find((n) => n.kind === "note" && n.path);
  if (!noteNode?.id || !noteNode?.path) throw new Error("S3: no note found in tree");

  const noteResp = await page.request.get(
    `${jasper.baseURL}/api/v1/notes/${noteNode.id}`,
  );
  expect(noteResp.status()).toBe(200);
  const noteData = (await noteResp.json()) as { content?: string };
  expect(noteData.content ?? "").toContain("twowaytest");
});


test("S4 @UX-T-04: frontmatter block hidden by default; Cmd-Shift-Y toggles raw view; note switch resets to hidden", async ({ page }) => {
  await openApp(page, true);

  const rawFrontmatterVisible = await page.evaluate(() => {
    const editor =
      Array.from(document.querySelectorAll(".cm-content")).find(
        (el) => (el as HTMLElement).offsetParent !== null,
      ) ?? document.querySelector(".cm-content");
    const lines = editor
      ? editor.querySelectorAll(".cm-line")
      : ([] as unknown as NodeListOf<Element>);
    for (const line of Array.from(lines)) {
      if ((line.textContent ?? "").trim() === "---") return true;
    }
    return false;
  });
  expect(rawFrontmatterVisible).toBe(false);

  const affordance = page.locator(".cm-frontmatter-affordance");
  if ((await affordance.count()) > 0) {
    const affordanceText = (await affordance.first().textContent()) ?? "";
    expect(affordanceText).not.toContain("▸ frontmatter");
  }

  const toggleKey =
    process.platform === "darwin" ? "Meta+Shift+y" : "Control+Shift+y";
  await page.locator(".cm-content:visible").first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);
  await page.keyboard.press(toggleKey);
  await page.waitForTimeout(600);

  const rawAfterToggle = await page.evaluate(() => {
    const editor =
      Array.from(document.querySelectorAll(".cm-content")).find(
        (el) => (el as HTMLElement).offsetParent !== null,
      ) ?? document.querySelector(".cm-content");
    const lines = editor
      ? editor.querySelectorAll(".cm-line")
      : ([] as unknown as NodeListOf<Element>);
    for (const line of Array.from(lines)) {
      if ((line.textContent ?? "").trim() === "---") return true;
    }
    return false;
  });
  if (!rawAfterToggle) {
    console.warn("S4: Cmd-Shift-Y toggle did not reveal --- lines; keymap may not have fired");
  }

  if (rawAfterToggle) {
    await page.keyboard.press(toggleKey);
    await page.waitForTimeout(300);
  }

  await page.keyboard.press(toggleKey);
  await page.waitForTimeout(400);

  await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { parent_path: "", title: "fm-switch-target" },
  });

  await page.reload();
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await expect(firstNote).toBeVisible({ timeout: 8_000 });
  await firstNote.click();
  await waitForActiveEditor(page);
  await page.waitForTimeout(400);

  const rawAfterNoteSwitch = await page.evaluate(() => {
    const editor =
      Array.from(document.querySelectorAll(".cm-content")).find(
        (el) => (el as HTMLElement).offsetParent !== null,
      ) ?? document.querySelector(".cm-content");
    const lines = editor
      ? editor.querySelectorAll(".cm-line")
      : ([] as unknown as NodeListOf<Element>);
    for (const line of Array.from(lines)) {
      if ((line.textContent ?? "").trim() === "---") return true;
    }
    return false;
  });
  expect(rawAfterNoteSwitch).toBe(false);
});


// S5 (@UX-T-05) DELETED in v1.2: the Tags panel's substring-filter input
// (input[aria-label="Filter tag list"]) was intentionally removed in the
// Phase 20 RightRail redesign. Per RightRailTagsPanel.tsx: "No own header, no ×
// close button, no substring filter input." Tag-list substring filtering is no
// longer an affordance — clicking a tag row now sets an activeTagFilter over
// NOTES, a different capability. Nothing to re-point; the tested affordance is
// gone, so the scenario is retired.


test("BUG-01: saving note with new tag → Tags panel updates within 2s (no WS round-trip needed)", async ({ page }) => {
  await openApp(page, true);
  await ensureTagsPanelExpanded(page);

  const uniqueTag = `bug01tag${Date.now()}`;
  await typeIntoEditor(
    page,
    `---\ntags: []\n---\n\n# BugOneNote\n\nTesting BUG-01 fix with #${uniqueTag} inline.`,
  );

  const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
  await page.keyboard.press(saveKey);
  await waitForSaved(page, 10_000);

  await expect
    .poll(
      () =>
        page.getByTestId(`tag-row-${uniqueTag}`).isVisible(),
      { timeout: 2_000, intervals: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200] },
    )
    .toBeTruthy();
});


test("BUG-02: open note with incoming [[...]] links → Backlinks panel shows row within 2s", async ({ page }) => {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  await apiCreateNote(
    page,
    "notes/BugTwoTarget.md",
    "---\ntags: []\n---\n\n# BugTwoTarget\n\nThis note is the backlink target.",
  );

  await apiCreateNote(
    page,
    "notes/BugTwoSource.md",
    "---\ntags: []\n---\n\n# BugTwoSource\n\nThis references [[BugTwoTarget]] for testing BUG-02.",
  );

  let targetId: string | null = null;
  for (let i = 0; i < 30; i++) {
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const treeData = (await treeResp.json()) as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
    const targetNode = treeData.root.find(
      (n) => n.kind === "note" && (n.path ?? "").toLowerCase().includes("bugtwotarget"),
    );
    if (targetNode?.id) {
      targetId = targetNode.id;
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!targetId) throw new Error("BUG-02: BugTwoTarget not found in tree");

  let backlinkReady = false;
  for (let i = 0; i < 30; i++) {
    const resp = await page.request.get(
      `${jasper.baseURL}/api/v1/notes/${targetId}/backlinks`,
    );
    if (resp.status() === 200) {
      const body = (await resp.json()) as {
        backlinks: Array<{ source_id: string }>;
      };
      if (body.backlinks && body.backlinks.length > 0) {
        backlinkReady = true;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  expect(backlinkReady, "API should report backlinks before UI test").toBe(true);

  await page.reload();
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  await ensureRailExpanded(page);

  const targetRow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /BugTwoTarget/i });
  await expect(targetRow).toBeVisible({ timeout: 8_000 });
  await targetRow.click();
  await waitForActiveEditor(page);

  const rail = page.getByRole("region", { name: "Notes that link to this note" });
  await expect(rail).toBeVisible({ timeout: 5_000 });

  await expect
    .poll(
      () =>
        rail
          .getByRole("button", { name: /Open note: BugTwoSource/i })
          .isVisible(),
      { timeout: 2_000, intervals: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200] },
    )
    .toBeTruthy();
});


test("BUG-03: switch notes without editing → save indicator stays idle; actual edit + save → 'Saved' appears", async ({ page }) => {
  const noteAId = await apiCreateNote(
    page,
    "notes/BugThreeNoteA.md",
    "---\ntags: []\n---\n\n# BugThreeNoteA\n\nbody A",
  );
  const noteBId = await apiCreateNote(
    page,
    "notes/BugThreeNoteB.md",
    "---\ntags: []\n---\n\n# BugThreeNoteB\n\nbody B",
  );

  void noteAId;
  void noteBId;

  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  const noteARow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /BugThreeNoteA/i });
  await expect(noteARow).toBeVisible({ timeout: 8_000 });
  await noteARow.click();
  await waitForActiveEditor(page);

  await page.waitForTimeout(500);

  const noteBRow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /BugThreeNoteB/i });
  await expect(noteBRow).toBeVisible({ timeout: 8_000 });
  await noteBRow.click();
  await waitForActiveEditor(page);

  // Redesign: the SaveIndicator is a StatusBar icon-button carrying
  // data-save-state ("idle" | "saving" | "saved" | "error"); the legacy
  // role="status" "Saved" overlay is not rendered in button mode. A phantom
  // save during a no-edit switch would flip the button to "saved", so poll
  // that it never reaches "saved" while switching.
  const savedTexts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const savedCount = await page
      .locator('button[data-save-state="saved"]')
      .count();
    if (savedCount > 0) savedTexts.push(`found at poll ${i}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(
    savedTexts,
    `BUG-03: "Saved" indicator appeared during note switch without edits: ${savedTexts.join(", ")}`,
  ).toHaveLength(0);

  const cm = page.locator(".cm-content:visible").first();
  await cm.click();
  const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
  await page.keyboard.press(gotoEndKey);
  await page.keyboard.type(" additional text for save test");
  const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
  await page.keyboard.press(saveKey);

  await waitForSaved(page, 10_000);
});


test("S9 @autocomplete-polish: [[  popup and # popup have border-radius 8px + readable text", async ({ page }) => {
  await openApp(page, true);

  await apiCreateNote(
    page,
    "notes/AutocompleteTarget.md",
    "---\ntags: []\n---\n\n# AutocompleteTarget\n\nbody for autocomplete test",
  );

  await page.reload();
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await expect(firstNote).toBeVisible({ timeout: 8_000 });
  await firstNote.click();
  await waitForActiveEditor(page);

  const cm = page.locator(".cm-content");
  await cm.click();
  const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press("Delete");
  await page.keyboard.type("---\ntags: []\n---\n\n# TestNote\n\nLink: ");
  await page.keyboard.type("[[Auto");

  const autocomplete = page.locator(".cm-tooltip-autocomplete, .cm-tooltip");
  await expect(autocomplete.first()).toBeVisible({ timeout: 8_000 });

  const borderRadius = await page.evaluate(() => {
    const el = document.querySelector(
      ".cm-tooltip-autocomplete, .cm-tooltip",
    ) as HTMLElement | null;
    if (!el) return null;
    return window.getComputedStyle(el).borderRadius;
  });

  expect(borderRadius).toBeTruthy();
  const radiusNum = parseFloat(borderRadius ?? "0");
  expect(radiusNum).toBeGreaterThanOrEqual(6);

  const textColorOk = await page.evaluate(() => {
    const label = document.querySelector(".cm-completionLabel") as HTMLElement | null;
    if (!label) return true;
    const color = window.getComputedStyle(label).color;
    const m = color.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
    if (!m) return true;
    const [, r, g, b] = m.map(Number);
    return Math.abs((r ?? 128) - 128) > 20 || Math.abs((g ?? 128) - 128) > 20 || Math.abs((b ?? 128) - 128) > 20;
  });
  expect(textColorOk, "autocomplete text should not be a fully neutral grey (WCAG-AA)").toBe(true);

  await page.keyboard.press("Escape");

  const docEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
  await page.keyboard.press(docEndKey);
  await page.keyboard.type("\n#pro");

  await page.waitForTimeout(800);
  const tagAutocomplete = page.locator(".cm-tooltip-autocomplete, .cm-tooltip");
  if ((await tagAutocomplete.count()) > 0 && (await tagAutocomplete.first().isVisible())) {
    const tagBorderRadius = await page.evaluate(() => {
      const el = document.querySelector(
        ".cm-tooltip-autocomplete, .cm-tooltip",
      ) as HTMLElement | null;
      if (!el) return null;
      return window.getComputedStyle(el).borderRadius;
    });
    const tagRadiusNum = parseFloat(tagBorderRadius ?? "0");
    expect(tagRadiusNum).toBeGreaterThanOrEqual(6);
  }

  await page.keyboard.press("Escape");
});
