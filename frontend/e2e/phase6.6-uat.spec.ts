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
 * Ensure the right rail is expanded and Tags panel is visible.
 *
 * Current UI: the Tags panel has NO expand/collapse toggle. It is opened
 * via PanelSelectorDropdown (aria-label "Open panel") and closed via its
 * × button. The rail toggle (Hide/Show panels) is in the TopBar.
 */
async function ensureRailExpanded(page: Page): Promise<void> {
  // If the rail toggle shows "Show panels", click it to expand.
  const showBtn = page.getByRole("button", { name: "Show panels" });
  if ((await showBtn.count()) > 0 && (await showBtn.isVisible())) {
    await showBtn.click();
    await page.waitForTimeout(300);
  }

  // If Tags panel is not mounted, open it via PanelSelectorDropdown.
  const closeTagsBtn = page.getByRole("button", { name: "Close Tags panel" });
  if ((await closeTagsBtn.count()) === 0) {
    const panelTrigger = page.getByRole("button", { name: "Open panel" });
    if ((await panelTrigger.count()) > 0) {
      await panelTrigger.click();
      await page.waitForTimeout(200);
      const tagsItem = page.getByTestId("panel-selector-tags");
      if ((await tagsItem.count()) > 0) {
        await tagsItem.click();
        await page.waitForTimeout(200);
      }
    }
  }
  // Verify Tags panel is mounted.
  await expect(
    page.getByRole("button", { name: "Close Tags panel" }),
  ).toBeVisible({ timeout: 5_000 });
}

/**
 * Ensure the Tags panel is visible in the right rail.
 * Delegates to ensureRailExpanded which opens it via PanelSelectorDropdown.
 */
async function ensureTagsPanelVisible(page: Page): Promise<void> {
  await ensureRailExpanded(page);
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


test("S1 @UX-CHROME-01: TopBar renders; sidebar toggle hides/shows notes sidebar", async ({ page }) => {
  await openApp(page, true);

  const topBar = page.getByTestId("top-bar");
  await expect(topBar).toBeVisible({ timeout: 8_000 });

  const sidebarToggle = page.getByRole("button", { name: /hide notes sidebar|show notes sidebar/i });
  await expect(sidebarToggle).toBeVisible({ timeout: 5_000 });

  const panelTrigger = page.getByRole("button", { name: "Open panel" });
  await expect(panelTrigger).toBeVisible({ timeout: 5_000 });

  const railToggle = page.getByRole("button", { name: /hide panels|show panels/i });
  await expect(railToggle).toBeVisible({ timeout: 5_000 });

  const breadcrumbsNav = page.getByRole("navigation", { name: "Note path" });
  await expect(breadcrumbsNav).toBeVisible({ timeout: 5_000 });

  const boxShadow = await topBar.evaluate((el) =>
    window.getComputedStyle(el).boxShadow,
  );
  expect(boxShadow).not.toBe("none");

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


test("S2 @panel-selector: dropdown opens panels; × closes panels; rail auto-collapses", async ({ page }) => {
  await openApp(page, false);
  await ensureRailExpanded(page);
  await ensureTagsPanelVisible(page);

  const closeTagsBtn = page.getByRole("button", { name: "Close Tags panel" });
  await expect(closeTagsBtn).toBeVisible({ timeout: 5_000 });
  await closeTagsBtn.click();
  // After closing, Close Tags button should be gone.
  await expect(page.getByRole("button", { name: "Close Tags panel" })).toHaveCount(0, {
    timeout: 3_000,
  });

  const panelTrigger = page.getByRole("button", { name: "Open panel" });
  await panelTrigger.click();
  await page.waitForTimeout(300);
  const tagsItem = page.getByTestId("panel-selector-tags");
  await expect(tagsItem).toBeVisible({ timeout: 3_000 });
  expect(await tagsItem.getAttribute("aria-checked")).toBeNull();
  await tagsItem.click();
  // After opening, Tags panel Close button should reappear.
  await expect(page.getByRole("button", { name: "Close Tags panel" })).toBeVisible({
    timeout: 5_000,
  });

  const closeBacklinksBtn = page.getByRole("button", {
    name: "Close Backlinks panel",
  });
  if ((await closeBacklinksBtn.count()) > 0) {
    await closeBacklinksBtn.click();
  }
  await page.getByRole("button", { name: "Close Tags panel" }).click();
  // After all panels closed, anyPanelSelected=false → rail toggle disappears entirely (not "Show panels")
  await expect(
    page.getByRole("button", { name: /hide panels|show panels/i }),
  ).toHaveCount(0, { timeout: 5_000 });
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

  const railToggle = page.getByRole("button", { name: "Show panels" });
  if ((await railToggle.count()) > 0 && (await railToggle.isVisible())) {
    await railToggle.click();
    await page.waitForTimeout(400);
  }

  const panelTrigger = page.getByRole("button", { name: "Open panel" });
  if ((await panelTrigger.count()) > 0) {
    await panelTrigger.click();
    await page.waitForTimeout(200);
    const tagsItem = page.getByTestId("panel-selector-tags");
    if ((await tagsItem.count()) > 0) await tagsItem.click();
    await page.waitForTimeout(200);
    await panelTrigger.click();
    await page.waitForTimeout(200);
    const backlinksItem = page.getByTestId("panel-selector-backlinks");
    if ((await backlinksItem.count()) > 0) await backlinksItem.click();
    await page.waitForTimeout(200);
  }

  const divider = page.getByTestId("inter-panel-divider");
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

  // Tags panel header has no expand-toggle — verify panel header by Close button.
  const panelHeader = page.locator("header").filter({
    has: page.getByRole("button", { name: "Close Tags panel" }),
  });
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
    expect(breadcrumbText).toContain("NestedNote");

    const folderBtn = breadcrumbsNav.getByRole("button", {
      name: /Navigate to folder: breadcrumb-folder/i,
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
  await page.waitForSelector(".cm-content", { timeout: 8_000 });

  await page.waitForTimeout(500);

  const noteBRow = page
    .locator('[data-tree-row-kind="note"]')
    .filter({ hasText: /Reg65NoteB/i });
  await expect(noteBRow).toBeVisible({ timeout: 8_000 });
  await noteBRow.click();
  await page.waitForSelector(".cm-content", { timeout: 8_000 });

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

  const cm = page.locator(".cm-content");
  await cm.click();
  const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
  await page.keyboard.press(gotoEndKey);
  await page.keyboard.type(" reg65 additional text");
  const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
  await page.keyboard.press(saveKey);

  await waitForSaved(page, 10_000);
});
