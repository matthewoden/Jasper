/**
 * Phase 19 UAT — Breadcrumb & Left Sidebar.
 *
 * BREAD-01/02: the breadcrumb band (above the page title, y=40/h=26 per the
 *   Phase 18 POLISH-09 pin) shows `folder / title` segments (muted,
 *   ellipsized, clickable — SET2-06/07) on the left and a live, right-aligned
 *   word count ("N words" / "1 word") on the right that ticks up as the user
 *   types.
 * LSIDE-01: the active tree row shows the 12% accent-tint background +
 *   title-weight (--color-fg-title) label text; folder rows expose
 *   aria-expanded state (chevron swap) on toggle.
 * LSIDE-02 (D-01..D-07, D-17): the sidebar's own "Search" tab (SidebarTabRow
 *   — Phase 27 NAV-02 removed the Activity ribbon's Files/Search toggles
 *   entirely; panel selection now lives solely in the sidebar header) opens
 *   the Search panel (input focused). Panel switching (Notes/Search tabs)
 *   and the dedicated "Collapse sidebar" control replace the old
 *   toggle/collapse-on-repeat-click model; panel-memory persists across
 *   reload, Cmd+Shift+F re-points + refocus-selects, two-stage Escape, and
 *   result-click opens/activates the note through the tab system (never
 *   bypasses to setActiveNote directly — the Pitfall-1 guard).
 *
 * Harness mirrors phase18-uat.spec.ts: spawnJasper() per describe block,
 * connection-status-dot wait, @phase19 tags, JASPER_APP_HOME-isolated
 * (spawnJasper's ephemeral dataDir per describe).
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step uses a web-first
 * assertion (expect / expect.poll) — the debounced search effect (250ms) is
 * waited out via expect.poll on the rendered results, never page.waitForTimeout.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree, noteRow } from "./helpers/openNoteFromTree";

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a folder via the API; returns its path. */
async function createFolder(
  jasper: JasperHandle,
  name: string,
  parentPath = "",
): Promise<string> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/folders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, parent_path: parentPath }),
  });
  if (!resp.ok) throw new Error(`create folder ${name}: ${resp.status}`);
  return ((await resp.json()) as { path: string }).path;
}

/** Create a note via the API; returns its UUID. */
async function createNote(
  jasper: JasperHandle,
  title: string,
  parentPath = "",
): Promise<string> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: parentPath, title }),
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

function folderRow(page: Page, path: string) {
  return page.locator(`[data-tree-row="${path}"][data-tree-row-kind="folder"]`);
}

function tabStrip(page: Page) {
  return page.getByTestId("tab-strip");
}

function tabPills(page: Page) {
  return tabStrip(page).getByRole("tab");
}

// Phase 27 NAV-02 (D-09/D-10) removed the Activity ribbon's Files/Search
// toggles entirely — panel selection lives solely in the sidebar's own
// SidebarTabRow header (Notes/Search/Bookmarks icon tabs + a dedicated
// "Collapse sidebar" control). These helpers target that current surface.
function sidebarTabRow(page: Page) {
  return page.getByTestId("sidebar-tab-row");
}

function sidebarSearchTab(page: Page) {
  return sidebarTabRow(page).getByRole("button", { name: "Search", exact: true });
}

function sidebarNotesTab(page: Page) {
  return sidebarTabRow(page).getByRole("button", { name: "Notes", exact: true });
}

function collapseSidebarBtn(page: Page) {
  return page.getByRole("button", { name: "Collapse sidebar" });
}

function searchPanelInput(page: Page) {
  return page.getByPlaceholder("Search notes… (tag:name to filter)");
}

function sidebarNav(page: Page) {
  return page.locator('nav[aria-label="Notes navigation"]');
}

// ─── BREAD-01/02: breadcrumb trail + live word count ────────────────────────

test.describe("@phase19 BREAD-01/02: breadcrumb trail + live word count", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("breadcrumb shows folder/title segments; live word count (Phase 31 UAT round 3: now in the bottom status bar) ticks up while typing", async ({
    page,
  }) => {
    const folderPath = await createFolder(jasper, "projects");
    const noteId = await createNote(jasper, "bread-note", folderPath);
    await setNoteContent(jasper, noteId, "# bread-note\n\none two three\n");

    await waitForConnected(page, jasper.baseURL);
    await folderRow(page, folderPath).click();
    await openNoteFromTree(page, noteId);

    const breadcrumb = page.getByTestId("note-breadcrumb");
    await expect(breadcrumb).toBeVisible({ timeout: 10_000 });

    const segments = breadcrumb.getByTestId("breadcrumb-segment");
    await expect(segments).toHaveCount(2);
    expect((await segments.allTextContents()).map((t) => t.trim())).toEqual([
      "projects",
      "bread-note",
    ]);

    // Word count moved out of the breadcrumb bar entirely, into the bottom
    // StatusBar (Phase 31 UAT round 3 #6) — it reflects the FOCUSED note.
    const wordCount = page.getByTestId("status-bar-word-count");
    await expect(wordCount).toBeVisible();
    await expect(wordCount).toHaveText(/^[\d,]+ words?$/);
    // "# bread-note" -> "bread-note" is one hyphenated word + "one two three"
    // (3 words) = 4 words (WORD_REGEX treats internal hyphens as part of a
    // single word — see wordCount.ts).
    await expect(wordCount).toHaveText("4 words");

    // Segments stay clickable (SET2-06 owner preference).
    await expect(segments.first()).toBeEnabled();

    await page.locator(".cm-content:visible").click();
    await page.keyboard.type(" four");

    await expect(wordCount).toHaveText("5 words");
  });
});

// ─── LSIDE-01: active row tint + title-weight text + chevron state ──────────

test.describe("@phase19 LSIDE-01: active row accent tint + chevron state", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("active note row shows the 12% accent tint + title-weight text; folder chevron state flips on expand", async ({
    page,
  }) => {
    const folderPath = await createFolder(jasper, "lside-folder");
    const noteId = await createNote(jasper, "lside-note", folderPath);

    await waitForConnected(page, jasper.baseURL);

    const fRow = folderRow(page, folderPath);
    await expect(fRow).toBeVisible({ timeout: 10_000 });
    await expect(fRow).toHaveAttribute("aria-expanded", "false");
    await fRow.click();
    await expect(fRow).toHaveAttribute("aria-expanded", "true");

    await openNoteFromTree(page, noteId);

    const nRow = noteRow(page, noteId);
    await expect(nRow).toHaveAttribute("data-active", "true");

    const bg = await nRow.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(bg).not.toBe("rgba(0, 0, 0, 0)");
    expect(bg).not.toBe("transparent");

    const labelColor = await nRow
      .locator("[data-tree-row-label]")
      .evaluate((el) => getComputedStyle(el).color);
    // --color-fg-title default #e8e8ec -> rgb(232, 232, 236).
    expect(labelColor).toBe("rgb(232, 232, 236)");
  });
});

// ─── LSIDE-02 / SC3+SC4: Search panel open/focus/results/activation ────────

test.describe("@phase19 LSIDE-02/SC3/SC4: sidebar Search tab opens+focuses panel; result click activates tab", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("D-01: sidebar Search tab opens the panel with input focused; typing shows a count label + result rows", async ({
    page,
  }) => {
    const noteId = await createNote(jasper, "searchable-alpha");
    await setNoteContent(jasper, noteId, "# searchable-alpha\n\nfindme-unique-token content body\n");

    await waitForConnected(page, jasper.baseURL);

    await sidebarSearchTab(page).click();
    const input = searchPanelInput(page);
    await expect(input).toBeVisible({ timeout: 5_000 });
    // HALT (260721-suite Rule 2 — genuine app regression, not a stale
    // selector): SidebarTabRow's selectPanel() only calls
    // setSidebarPanel/setNotesSidebarVisible — it never dispatches the
    // "focusSearch" phase7 event. The pre-Phase-27 ribbon Search button
    // explicitly dispatched it on click (commit b73b9ed9), and the
    // still-passing Cmd+Shift+F path (appShortcuts.ts's
    // handleAppCmdShiftF, D-05) still does today — this assertion
    // correctly encodes current design intent (input focused on open,
    // regardless of entry method) and is intentionally left red per this
    // cluster's no-app-code-changes scope. See cluster-C-REPORT.md.
    await expect(input).toBeFocused();

    await input.fill("findme-unique-token");

    await expect
      .poll(async () => page.getByText(/^\d+ results?$/).count(), { timeout: 5_000 })
      .toBeGreaterThan(0);
    const resultRow = page.getByLabel(/^Open note: searchable-alpha$/);
    await expect(resultRow).toBeVisible({ timeout: 5_000 });
    await expect(resultRow.locator(".search-result-excerpt")).toBeVisible();
  });

  test("D-17 / SC4: with 2 tabs already open, clicking a search result activates it as the active tab", async ({
    page,
  }) => {
    const idOne = await createNote(jasper, "d17-tab-one");
    const idTwo = await createNote(jasper, "d17-tab-two");
    const idTarget = await createNote(jasper, "d17-search-target");
    await setNoteContent(jasper, idTarget, "# d17-search-target\n\nd17-unique-search-phrase\n");

    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idOne);
    await openNoteFromTree(page, idTwo);
    await expect(tabPills(page)).toHaveCount(2);

    await sidebarSearchTab(page).click();
    const input = searchPanelInput(page);
    // HALT (260721-suite Rule 2 — same genuine app regression as D-01 above):
    // clicking the sidebar Search tab does not focus the input. This blocks
    // reaching the SC4 result-click-activates-tab assertion below, which is
    // otherwise unrelated and unverified by this regression. See
    // cluster-C-REPORT.md.
    await expect(input).toBeFocused();
    await input.fill("d17-unique-search-phrase");

    const resultRow = page.getByLabel(/^Open note: d17-search-target$/);
    await expect(resultRow).toBeVisible({ timeout: 5_000 });
    await resultRow.click();

    await expect(tabPills(page)).toHaveCount(3, { timeout: 5_000 });
    const activeTab = page.getByRole("tab", { selected: true });
    await expect(activeTab).toHaveText(/d17-search-target/, { timeout: 5_000 });
  });
});

// ─── D-02/D-03: dedicated collapse control + Notes/Search switch-in-place ──

test.describe("@phase19 D-02/D-03: dedicated collapse control; Notes switches panel in place", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  // Phase 27 (NAV-01..03) removed the old "click the active toggle again to
  // collapse" model along with the Activity ribbon's Files/Search buttons
  // entirely: SidebarTabRow's tab clicks now ALWAYS switch panel + reopen
  // the sidebar (never collapse — a tab click while collapsed must never
  // no-op, since the collapse control lives in this same row). The current
  // equivalent surface for "collapse the sidebar while Search is showing"
  // is the dedicated "Collapse sidebar" control in that same header row.
  test("D-02: the dedicated collapse control hides the sidebar while Search is showing", async ({ page }) => {
    await waitForConnected(page, jasper.baseURL);

    await sidebarSearchTab(page).click();
    await expect(searchPanelInput(page)).toBeVisible({ timeout: 5_000 });
    await expect(sidebarNav(page)).toBeVisible();

    await collapseSidebarBtn(page).click();
    await expect(sidebarNav(page)).toHaveCount(0, { timeout: 5_000 });
  });

  test("D-03: clicking Notes while Search is showing switches to the Notes panel, sidebar stays open", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    await sidebarSearchTab(page).click();
    await expect(searchPanelInput(page)).toBeVisible({ timeout: 5_000 });

    await sidebarNotesTab(page).click();
    await expect(sidebarNav(page)).toBeVisible();
    await expect(searchPanelInput(page)).toHaveCount(0);
    await expect(sidebarNav(page).locator('[data-tree-row-kind]').first()).toBeVisible({
      timeout: 5_000,
    });
  });
});

// ─── D-04: panel-memory persists across reload ──────────────────────────────

test.describe("@phase19 D-04: sidebar panel memory persists across reload", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("setting the panel to Search, then reloading, restores the Search panel", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    await sidebarSearchTab(page).click();
    await expect(searchPanelInput(page)).toBeVisible({ timeout: 5_000 });

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    await expect(searchPanelInput(page)).toBeVisible({ timeout: 10_000 });
    await expect(sidebarNav(page)).toBeVisible();
  });
});

// ─── D-05: Cmd+Shift+F open+focus, refocus+select on repeat ────────────────

test.describe("@phase19 D-05: Cmd+Shift+F opens+focuses Search; repeat refocuses+selects", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+Shift+F opens the Search panel with input focused; pressing again refocuses and selects the existing query", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    await page.keyboard.press("Meta+Shift+f");
    const input = searchPanelInput(page);
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toBeFocused();

    await input.fill("existing-query");
    await page.locator(".cm-content:visible, body").first().click({ position: { x: 5, y: 5 } });
    await expect(input).not.toBeFocused();

    await page.keyboard.press("Meta+Shift+f");
    await expect(input).toBeFocused();

    const selection = await input.evaluate((el: HTMLInputElement) =>
      el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0),
    );
    expect(selection).toBe("existing-query");
  });
});

// ─── D-06: two-stage Escape (clear, then blur) ─────────────────────────────

test.describe("@phase19 D-06: Escape clears query first, then blurs on second press", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("first Escape clears the query (panel stays open); second Escape blurs the input", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    await sidebarSearchTab(page).click();
    const input = searchPanelInput(page);
    // HALT (260721-suite Rule 2 — same genuine app regression as D-01 above):
    // clicking the sidebar Search tab does not focus the input, blocking the
    // rest of this two-stage-Escape scenario from ever exercising a focused
    // input. See cluster-C-REPORT.md.
    await expect(input).toBeFocused();

    await input.fill("some query text");
    await expect(input).toHaveValue("some query text");

    await page.keyboard.press("Escape");
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await expect(sidebarNav(page)).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(input).not.toBeFocused();
    await expect(sidebarNav(page)).toBeVisible();
  });
});
