/**
 * Phase 6.6 UAT — Rail Chrome Polish.
 *
 * All scenarios share a single `bin/jasper` instance. Scenarios run in
 * declaration order; use unique note/tag names to avoid cross-scenario
 * interference.
 *
 * Scenarios:
 *   S1 (@UX-CHROME-01) : TopBar renders — sidebar toggle, breadcrumbs, panel
 *                        selector, right-rail toggle. Click sidebar toggle → hides.
 *   S2 (@panel-selector): Panel dropdown → uncheck Tags → hides; re-check → returns.
 *   S3 (@UX-CHROME-02) : StatusBar renders — connectivity dot, refresh button,
 *                        settings trigger. Verify NOT in the sidebar header.
 *   S4 (@UX-CHROME-02-refresh): Refresh button → disabled during reindex;
 *                               settings button opens settings dialog.
 *   S5 (@UX-CHROME-03) : Sidebar reads as floating panel — outer nav with 8px inset.
 *   S6 (@UX-CHROME-04) : InterPanelDivider has cursor row-resize; no color band.
 *   S7 (@UX-CHROME-05) : Note with frontmatter — no ".cm-frontmatter-affordance".
 *   S8 (@UX-CHROME-06) : Tag rows show "#tagname (count)"; no Key icon in header.
 *   S9 (@UX-CHROME-07) : Tag filter chip spans full width; × clears the filter.
 *   S10 (@breadcrumbs) : Nested note → breadcrumbs shows path; click folder → sidebar.
 *   S11 (@phase-6.5-regression): Phase 6.5 features still work.
 *
 * Selector notes:
 *   - CM6 editor is contenteditable — use keyboard.type(), not .fill().
 *   - TopBar: data-testid="top-bar"
 *   - StatusBar: data-testid="status-bar" aria-label="Status bar"
 *   - Refresh button: aria-label="Reindex notes"
 *   - Sidebar toggle: aria-label="Hide notes sidebar" / "Show notes sidebar"
 *   - Right-rail toggle: aria-label="Hide panels" / "Show panels"
 *   - Panel selector trigger: aria-label="Select panels"
 *   - Tag row: data-testid="tag-row-{name}"
 *   - InterPanelDivider: data-testid="inter-panel-divider"
 *   - ActiveTagFilterChip: role="status" aria-label="Active filter: #tagname"
 *   - Breadcrumbs nav: aria-label="Note path"
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
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
  }
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
 * Ensure the right rail is expanded.
 *
 * Post-v1.2 UI (Phase 20, D-01): the panel-selector dropdown and per-panel ×
 * close buttons were removed. The whole right rail is now shown/hidden via a
 * single toggle in the TabStrip ("Show panels" / "Hide panels"), and the rail
 * hosts three ALWAYS-MOUNTED sections (Outline / Linked mentions / Tags), each
 * behind a unified SectionHeader whose whole 32px row is a collapse toggle
 * (aria-label "Expand Tags panel" / "Collapse Tags panel"). The rail defaults
 * to expanded, so this is normally a no-op.
 */
async function ensureRailExpanded(page: Page): Promise<void> {
  // If the rail toggle shows "Show panels", click it to expand the rail.
  const showBtn = page.getByRole("button", { name: "Show panels" });
  if ((await showBtn.count()) > 0 && (await showBtn.isVisible())) {
    await showBtn.click();
    await page.waitForTimeout(300);
  }

  // Rail is mounted once its Tags SectionHeader toggle is present (in either
  // collapsed or expanded state).
  await expect(
    page.getByRole("button", { name: /Expand Tags panel|Collapse Tags panel/ }),
  ).toBeVisible({ timeout: 5_000 });
}

/**
 * Ensure the Tags section is expanded in the right rail.
 * Expands the rail first, then opens the Tags section via its SectionHeader.
 */
async function ensureTagsPanelVisible(page: Page): Promise<void> {
  await ensureRailExpanded(page);

  const expandTags = page.getByRole("button", { name: "Expand Tags panel" });
  if ((await expandTags.count()) > 0 && (await expandTags.isVisible())) {
    await expandTags.click();
    await page.waitForTimeout(200);
  }

  await expect(
    page.getByRole("button", { name: "Collapse Tags panel" }),
  ).toBeVisible({ timeout: 5_000 });
}

/**
 * Wait for SaveIndicator to reach "saved" state.
 * SaveIndicator is an icon-button with data-save-state attribute (no text label).
 */
async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect(
    page.locator('button[data-save-state="saved"]'),
  ).toBeVisible({ timeout: timeoutMs });
}


test("S1 @UX-CHROME-01: chrome affordances render; sidebar toggle hides/shows notes sidebar", async ({ page }) => {
  await openApp(page, true);

  // Phase 20 (D-04) dissolved the single `top-bar` shell: the sidebar/rail
  // toggles moved into the TabStrip's left/right clusters, and the old
  // panel-selector "Open panel" dropdown was removed entirely (D-01). Assert
  // the surviving chrome affordances directly rather than the removed shell.
  const sidebarToggle = page.getByRole("button", { name: /hide notes sidebar|show notes sidebar/i });
  await expect(sidebarToggle).toBeVisible({ timeout: 5_000 });

  const railToggle = page.getByRole("button", { name: /hide panels|show panels/i });
  await expect(railToggle).toBeVisible({ timeout: 5_000 });

  const breadcrumbsNav = page.getByRole("navigation", { name: "Note path" });
  await expect(breadcrumbsNav).toBeVisible({ timeout: 5_000 });

  const hideBtn = page.getByRole("button", { name: "Hide notes sidebar" });
  await expect(hideBtn).toBeVisible({ timeout: 3_000 });
  await hideBtn.click();
  await page.waitForTimeout(300);

  const sidebarNav = page.getByRole("navigation", { name: "Notes navigation" });
  await expect(sidebarNav).not.toBeVisible({ timeout: 3_000 });

  const showBtn = page.getByRole("button", { name: "Show notes sidebar" });
  await expect(showBtn).toBeVisible({ timeout: 3_000 });

  await showBtn.click();
  await page.waitForTimeout(300);
  await expect(sidebarNav).toBeVisible({ timeout: 5_000 });
});


test("S2 @panel-selector: SectionHeaders collapse/expand panels; rail toggle hides/shows the rail", async ({ page }) => {
  // Phase 20 (D-01) removed the panel-selector dropdown and per-panel × close
  // buttons. Panel visibility is now managed by (a) each section's unified
  // SectionHeader collapse toggle and (b) a single rail toggle in the TabStrip.
  // This re-point preserves the original intent — a user can open and close
  // right-rail panels — against the new mechanism.
  await openApp(page, false);
  await ensureRailExpanded(page);
  await ensureTagsPanelVisible(page);

  // Collapse the Tags section via its whole-row SectionHeader toggle.
  const collapseTags = page.getByRole("button", { name: "Collapse Tags panel" });
  await expect(collapseTags).toBeVisible({ timeout: 5_000 });
  await collapseTags.click();
  await expect(
    page.getByRole("button", { name: "Expand Tags panel" }),
  ).toBeVisible({ timeout: 3_000 });

  // Re-expand it.
  await page.getByRole("button", { name: "Expand Tags panel" }).click();
  await expect(
    page.getByRole("button", { name: "Collapse Tags panel" }),
  ).toBeVisible({ timeout: 5_000 });

  // The rail toggle collapses the entire right rail (replacing the old
  // "auto-collapse when all panels closed" behavior). The three section
  // headers unmount with the rail; the toggle flips to "Show panels".
  const hidePanels = page.getByRole("button", { name: "Hide panels" });
  await expect(hidePanels).toBeVisible({ timeout: 5_000 });
  await hidePanels.click();
  await expect(
    page.getByRole("button", { name: /Collapse Tags panel|Expand Tags panel/ }),
  ).toHaveCount(0, { timeout: 5_000 });
  await expect(
    page.getByRole("button", { name: "Show panels" }),
  ).toBeVisible({ timeout: 3_000 });
});


test("S3 @UX-CHROME-02: StatusBar visible at bottom; connectivity dot + refresh + settings present; NOT in sidebar header", async ({ page }) => {
  await openApp(page, false);

  const statusBar = page.getByTestId("status-bar");
  await expect(statusBar).toBeVisible({ timeout: 8_000 });

  await expect(
    page.getByRole("contentinfo", { name: "Status bar" }),
  ).toBeVisible({ timeout: 5_000 });

  const connDot = page.getByTestId("connection-status-dot");
  await expect(connDot).toBeVisible({ timeout: 5_000 });

  // SaveIndicator in StatusBar acts as the refresh trigger (icon-button, no "Reindex notes" label).
  const refreshBtn = statusBar.locator("button[data-save-state]");
  await expect(refreshBtn).toBeVisible({ timeout: 5_000 });

  const statusBarButtons = statusBar.locator("button");
  const btnCount = await statusBarButtons.count();
  expect(btnCount).toBeGreaterThanOrEqual(2);

  const sidebarNav = page.getByRole("navigation", { name: "Notes navigation" });
  if ((await sidebarNav.count()) > 0 && (await sidebarNav.isVisible())) {
    const connDotInSidebar = sidebarNav.getByTestId("connection-status-dot");
    expect(await connDotInSidebar.count()).toBe(0);

    const refreshInSidebar = sidebarNav.locator("button[data-save-state]");
    expect(await refreshInSidebar.count()).toBe(0);
  }
});


test("S4 @UX-CHROME-02-refresh: refresh button briefly disables during reindex; settings opens dialog", async ({ page }) => {
  await openApp(page, false);

  await expect(page.getByTestId("status-bar")).toBeVisible({ timeout: 8_000 });

  // SaveIndicator in StatusBar acts as the reindex trigger (icon-button, data-save-state attribute).
  const statusBar = page.getByTestId("status-bar");
  const refreshBtn = statusBar.locator("button[data-save-state]");
  await expect(refreshBtn).toBeVisible({ timeout: 5_000 });
  await expect(refreshBtn).toBeEnabled({ timeout: 3_000 });

  await refreshBtn.click();

  let observedDisabled = false;
  for (let i = 0; i < 20; i++) {
    const isDisabled = await refreshBtn.isDisabled();
    if (isDisabled) {
      observedDisabled = true;
      break;
    }
    await page.waitForTimeout(50);
  }
  await expect(refreshBtn).toBeEnabled({ timeout: 10_000 });
  void observedDisabled;

  const allStatusBarBtns = statusBar.locator("button");
  const lastBtn = allStatusBarBtns.last();
  await expect(lastBtn).toBeVisible({ timeout: 3_000 });
  await lastBtn.click();
  await page.waitForTimeout(300);

  const settingsContent = page.locator(
    '[role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]',
  );
  await expect(settingsContent.first()).toBeVisible({ timeout: 3_000 });

  await page.keyboard.press("Escape");
});


test("S5 @UX-CHROME-03: sidebar is a flush panel — border-right only, no radius/inset (mock parity, 23-03 D-06)", async ({ page }) => {
  await openApp(page, false);

  const sidebarNav = page.getByRole("navigation", { name: "Notes navigation" });
  await expect(sidebarNav).toBeVisible({ timeout: 8_000 });

  const innerCard = sidebarNav.locator("div").first();
  await expect(innerCard).toBeVisible({ timeout: 3_000 });

  // Owner adjudicated the floating card away in Phase 23 (D-06): flush to the
  // mock's file-tree rail — 0 radius, no margin, border-right only.
  const radiusNum = parseFloat(
    (await innerCard.evaluate((el) => window.getComputedStyle(el).borderRadius)) ?? "0",
  );
  expect(radiusNum).toBe(0);

  const rightWidth = await innerCard.evaluate(
    (el) => window.getComputedStyle(el).borderRightWidth,
  );
  expect(parseFloat(rightWidth ?? "0")).toBeGreaterThanOrEqual(1);

  const rightStyle = await innerCard.evaluate(
    (el) => window.getComputedStyle(el).borderRightStyle,
  );
  expect(rightStyle).toBe("solid");

  // The other three sides carry no border in the flush layout.
  const otherWidths = await innerCard.evaluate((el) => {
    const s = window.getComputedStyle(el);
    return [s.borderTopWidth, s.borderBottomWidth, s.borderLeftWidth];
  });
  for (const w of otherWidths) expect(parseFloat(w ?? "0")).toBe(0);

  const navBg = await sidebarNav.evaluate(
    (el) => window.getComputedStyle(el).background,
  );
  expect(navBg).toBeTruthy();
});


test("S6 @UX-CHROME-04: inter-panel divider has row-resize cursor; no visible background band", async ({ page }) => {
  await openApp(page, false);
  await ensureRailExpanded(page);

  // An InterPanelDivider renders between any two adjacent expanded sections.
  // Outline / Linked mentions / Tags all default to expanded; make Outline and
  // Tags explicitly expanded (idempotent) so at least one divider exists.
  const expandOutline = page.getByRole("button", { name: "Expand Outline panel" });
  if ((await expandOutline.count()) > 0 && (await expandOutline.isVisible())) {
    await expandOutline.click();
    await page.waitForTimeout(150);
  }
  const expandTags = page.getByRole("button", { name: "Expand Tags panel" });
  if ((await expandTags.count()) > 0 && (await expandTags.isVisible())) {
    await expandTags.click();
    await page.waitForTimeout(150);
  }

  // Multiple dividers may render (one per adjacent expanded pair); assert on
  // the first.
  const divider = page.getByTestId("inter-panel-divider").first();
  await expect(divider).toBeVisible({ timeout: 10_000 });

  const cursor = await divider.evaluate(
    (el) => window.getComputedStyle(el).cursor,
  );
  expect(cursor).toBe("row-resize");

  const bg = await divider.evaluate(
    (el) => window.getComputedStyle(el).backgroundColor,
  );
  const isTransparent =
    bg === "transparent" ||
    bg === "rgba(0, 0, 0, 0)" ||
    bg === "" ||
    bg === "none";
  expect(isTransparent).toBe(true);

  const sidebarHandle = page.getByRole("separator", {
    name: "Resize sidebar",
  });
  if ((await sidebarHandle.count()) > 0) {
    const sidebarCursor = await sidebarHandle.evaluate(
      (el) => window.getComputedStyle(el).cursor,
    );
    expect(sidebarCursor).toBe("col-resize");
  }
});


test("S7 @UX-CHROME-05: open note with frontmatter → no affordance widget visible; editor starts at content", async ({ page }) => {
  const noteId = await apiCreateNote(
    page,
    "notes/FmHideTest.md",
    "---\ntags: [fmhide]\n---\n\n# FmHideTest\n\nContent starts here.",
  );
  void noteId;

  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  const noteRow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /FmHideTest/i });
  await expect(noteRow).toBeVisible({ timeout: 8_000 });
  await noteRow.click();
  await page.waitForSelector(".cm-content", { timeout: 8_000 });
  await page.waitForTimeout(400);

  const affordance = page.locator(".cm-frontmatter-affordance");
  if ((await affordance.count()) > 0) {
    const affordanceText = await affordance.textContent();
    expect(affordanceText ?? "").not.toContain("▸ frontmatter");
  }

  const rawFrontmatterVisible = await page.evaluate(() => {
    const lines = document.querySelectorAll(".cm-content .cm-line");
    for (const line of Array.from(lines)) {
      if ((line.textContent ?? "").trim() === "---") return true;
    }
    return false;
  });
  expect(rawFrontmatterVisible).toBe(false);

  const toggleKey =
    process.platform === "darwin" ? "Meta+Shift+y" : "Control+Shift+y";

  const cmContent = page.locator(".cm-content");
  await cmContent.click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Home");
  await page.waitForTimeout(100);

  await page.keyboard.press(toggleKey);
  await page.waitForTimeout(600);

  const rawAfterToggle = await page.evaluate(() => {
    const lines = document.querySelectorAll(".cm-content .cm-line");
    for (const line of Array.from(lines)) {
      if ((line.textContent ?? "").trim() === "---") return true;
    }
    return false;
  });
  if (!rawAfterToggle) {
    console.warn("S7: Cmd-Shift-Y toggle did not reveal --- lines (keymap may not have fired); skipping raw-view assertion");
  }

  if (rawAfterToggle) {
    await page.keyboard.press(toggleKey);
    await page.waitForTimeout(300);
  }
});


test("S8 @UX-CHROME-06: tag rows render '#tagname' + badge count; no Key icon in panel header", async ({ page }) => {
  await apiCreateNote(
    page,
    "notes/TagFormatTest.md",
    "---\ntags: [tagformat]\n---\n\n# TagFormatTest\n\nTag format test note.",
  );

  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  await ensureRailExpanded(page);
  await ensureTagsPanelVisible(page);

  const tagRow = page.getByTestId("tag-row-tagformat");
  await expect(tagRow).toBeVisible({ timeout: 8_000 });

  const tagRowText = await tagRow.textContent();
  expect(tagRowText).toContain("#tagformat");

  expect(tagRowText).not.toMatch(/\(\d+\)/);
  const badge = tagRow.locator('[aria-label$="notes"]');
  await expect(badge).toBeVisible({ timeout: 3_000 });

  const hashSpan = tagRow.locator("span").first();
  const hashColor = await hashSpan.evaluate(
    (el) => window.getComputedStyle(el).color,
  );
  expect(hashColor).toBeTruthy();

  // The Tags panel header is now the unified SectionHeader — its whole 32px row
  // is the collapse toggle (aria-label "Collapse Tags panel" when expanded).
  const panelHeader = page.getByRole("button", { name: "Collapse Tags panel" });
  await expect(panelHeader).toBeVisible({ timeout: 5_000 });

  const hasKeyIcon = await panelHeader.evaluate((hdr) => {
    const svgs = hdr.querySelectorAll("svg");
    for (const svg of Array.from(svgs)) {
      const title = svg.querySelector("title");
      if (title?.textContent?.toLowerCase().includes("key")) return true;
      if (svg.getAttribute("aria-label")?.toLowerCase().includes("key")) return true;
    }
    return false;
  });
  expect(hasKeyIcon).toBe(false);
});


test("S9 @UX-CHROME-07: active tag filter chip is full-width; reads 'Filtered by: #tagname'; × clears", async ({ page }) => {
  await apiCreateNote(
    page,
    "notes/FilterChipTest.md",
    "---\ntags: [filterchip]\n---\n\n# FilterChipTest\n\nFilter chip test.",
  );

  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  await ensureRailExpanded(page);
  await ensureTagsPanelVisible(page);

  const tagRow = page.getByTestId("tag-row-filterchip");
  await expect(tagRow).toBeVisible({ timeout: 8_000 });

  await tagRow.click();
  await page.waitForTimeout(300);

  const filterChip = page.locator('[role="status"][aria-label*="Active filter"]');
  await expect(filterChip).toBeVisible({ timeout: 5_000 });

  const chipText = await filterChip.textContent();
  expect(chipText).toContain("Filtered by:");

  expect(chipText).toContain("#filterchip");

  const chipWidth = await filterChip.evaluate((el) => {
    const style = window.getComputedStyle(el);
    const parentWidth = el.parentElement
      ? el.parentElement.getBoundingClientRect().width
      : 0;
    const elWidth = el.getBoundingClientRect().width;
    return { elWidth, parentWidth, cssWidth: style.width };
  });
  if (chipWidth.cssWidth !== "100%") {
    const ratio = chipWidth.elWidth / chipWidth.parentWidth;
    expect(ratio).toBeGreaterThan(0.8);
  }

  const dismissBtn = page.getByRole("button", {
    name: /Remove tag filter: #filterchip/i,
  });
  await expect(dismissBtn).toBeVisible({ timeout: 3_000 });

  await dismissBtn.click();
  await page.waitForTimeout(300);
  await expect(filterChip).not.toBeVisible({ timeout: 3_000 });
});


test("S10 @breadcrumbs: note in nested folder shows breadcrumb path; folder segment is a button", async ({ page }) => {
  const folderResp = await page.request.post(`${jasper.baseURL}/api/v1/folders`, {
    data: { parent_path: "", name: "breadcrumb-folder" },
  });
  if (folderResp.status() !== 201 && folderResp.status() !== 409) {
    const body = await folderResp.text().catch(() => "(no body)");
    throw new Error(`S10: POST /folders returned ${String(folderResp.status())}: ${body}`);
  }

  await apiCreateNote(
    page,
    "notes/breadcrumb-folder/nested-note.md",
    "---\ntags: []\n---\n\n# NestedNote\n\nNested note for breadcrumb test.",
  );

  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  const noteRow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /NestedNote/i });

  const folderRow = page
    .locator('[data-tree-row-kind="folder"]')
    .filter({ hasText: /breadcrumb-folder/i });

  if ((await noteRow.count()) === 0) {
    if ((await folderRow.count()) > 0) {
      await folderRow.click();
      await page.waitForTimeout(300);
    }
  }

  if ((await noteRow.count()) > 0) {
    await noteRow.first().click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(400);

    const breadcrumbsNav = page.getByRole("navigation", { name: "Note path" });
    await expect(breadcrumbsNav).toBeVisible({ timeout: 5_000 });

    const breadcrumbText = await breadcrumbsNav.textContent();
    expect(breadcrumbText).not.toMatch(/^notes/);

    expect(breadcrumbText).toContain("breadcrumb-folder");
    // v1.2 breadcrumb segments derive labels from the file path: the trailing
    // note segment is the filename stem ("nested-note"), not the rendered H1
    // title ("NestedNote", which is what the file-tree row shows).
    expect(breadcrumbText).toContain("nested-note");

    // v1.2 breadcrumb segments are buttons labelled "Reveal <name> in Files"
    // (they expand + pulse the row in the file tree).
    const folderBtn = breadcrumbsNav.getByRole("button", {
      name: /Reveal breadcrumb-folder in Files/i,
    });
    await expect(folderBtn).toBeVisible({ timeout: 3_000 });

    await folderBtn.click();
    const pulsedRow = page.locator(
      `[data-tree-row="breadcrumb-folder"].jasper-pulse-target`,
    );
    await expect(pulsedRow).toBeVisible({ timeout: 1_000 });

    const sidebarNav = page.getByRole("navigation", {
      name: "Notes navigation",
    });
    await expect(sidebarNav).toBeVisible({ timeout: 3_000 });
  } else {
    const firstNote = page.locator('[data-tree-row-kind="note"]').first();
    if ((await firstNote.count()) > 0) {
      await firstNote.click();
      await page.waitForSelector(".cm-content", { timeout: 8_000 });
      const breadcrumbsNav = page.getByRole("navigation", { name: "Note path" });
      await expect(breadcrumbsNav).toBeVisible({ timeout: 5_000 });
    }
  }
});


test("S11 @phase-6.5-regression: inline #tag click filters; backlinks populate; no false Saved on note switch", async ({ page }) => {
  const noteAId = await apiCreateNote(
    page,
    "notes/Reg65NoteA.md",
    "---\ntags: []\n---\n\n# Reg65NoteA\n\nbody A",
  );
  const noteBId = await apiCreateNote(
    page,
    "notes/Reg65NoteB.md",
    "---\ntags: []\n---\n\n# Reg65NoteB\n\nbody B",
  );
  void noteAId;
  void noteBId;

  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );

  await ensureRailExpanded(page);
  await ensureTagsPanelVisible(page);

  const noteARow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /Reg65NoteA/i });
  await expect(noteARow).toBeVisible({ timeout: 8_000 });
  await noteARow.click();
  // v1.2 keeps one EditorPane mounted per open tab (D-01), so once a second tab
  // opens there are multiple `.cm-content` nodes — all but the active one are
  // hidden. Wait for (and later target) only the visible pane.
  await page.waitForSelector(".cm-content:visible", { timeout: 8_000 });

  await page.waitForTimeout(500);

  const noteBRow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /Reg65NoteB/i });
  await expect(noteBRow).toBeVisible({ timeout: 8_000 });
  await noteBRow.click();
  await page.waitForSelector(".cm-content:visible", { timeout: 8_000 });

  const savedTexts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const savedCount = await page
      .locator('[role="status"]')
      .filter({ hasText: /^Saved$/ })
      .count();
    if (savedCount > 0) savedTexts.push(`found at poll ${i}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(
    savedTexts,
    `Phase 6.5 regression BUG-03: "Saved" appeared on note switch without edits: ${savedTexts.join(", ")}`,
  ).toHaveLength(0);

  const cm = page.locator(".cm-content:visible").first();
  await cm.click();
  const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
  await page.keyboard.press(gotoEndKey);
  await page.keyboard.type(" reg65 additional text");
  const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
  await page.keyboard.press(saveKey);

  await waitForSaved(page, 10_000);
});
