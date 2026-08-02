/**
 * Sort orders and search history against the real binary.
 *
 * Timestamp control differs per test, avoiding two discovered pitfalls:
 *   - Tree "Modified" may use seedNoteWithMtime (fs.utimes) plus a full
 *     admin/reindex, because the tree's updated_at is sourced from mtime_unix,
 *     which a full reindex preserves per file.
 *   - Search "Modified"/"Created" must NOT. A full reindex mints fresh note ids
 *     and homogenizes the SQL updated_at column to the reindex instant for every
 *     row; separately, fs.utimes-ing an mtime to before the file's real birthtime
 *     is silently clamped by APFS, dragging birthtime down with it. Real
 *     create-then-edit timing drives genuinely distinct values instead.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote, seedNoteWithMtime, waitForConnected } from "./helpers/phase7Helpers";

// ─── Shared helpers ──────────────────────────────────────────────────────────

function notesNav(page: Page) {
  return page.locator('nav[aria-label="Notes navigation"]');
}

function tabRow(page: Page) {
  return page.getByTestId("sidebar-tab-row");
}

function searchPanelInput(page: Page) {
  return page.getByPlaceholder("Search notes… (tag:name to filter)");
}

function recentSearchesListbox(page: Page) {
  return page.getByRole("listbox", { name: "Recent searches" });
}

/** Create a folder via the API; returns its canonical path. */
async function apiCreateFolder(
  page: Page,
  baseURL: string,
  name: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/folders`, {
    data: { name, parent_path: parentPath },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateFolder: POST returned ${String(resp.status())} for ${name}: ${body}`,
    );
  }
  const created = (await resp.json()) as { path: string };
  return created.path;
}

/** Overwrite a note's body content via the API (no If-Match — force write); bumps mtime/updated_at. */
async function apiUpdateNoteContent(
  page: Page,
  baseURL: string,
  id: string,
  content: string,
): Promise<void> {
  const resp = await page.request.put(`${baseURL}/api/v1/notes/${id}`, {
    data: { content },
  });
  if (resp.status() !== 200) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiUpdateNoteContent: PUT returned ${String(resp.status())} for ${id}: ${body}`);
  }
}

/**
 * Real-time wait used ONLY to guarantee two filesystem timestamps (mtime or
 * birthtime) fall in different whole seconds. macOS's Birthtimespec
 * (birthtime_darwin.go) is truncated to second resolution; operations
 * performed within the same test function run within milliseconds of each
 * other and would otherwise tie, making "Modified"/"Created" sort order
 * ambiguous/order-by-tiebreak instead of the true chronological order these
 * tests assert. This is deliberate seed-data determinism, not a
 * wait-for-eventual-UI-condition sleep.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full re-index (mode: "full") — returns only after the rebuild finishes. */
async function triggerFullReindex(page: Page, baseURL: string): Promise<void> {
  const resp = await page.request.post(`${baseURL}/api/v1/admin/reindex`, {
    data: { mode: "full" },
  });
  if (resp.status() !== 202) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`triggerFullReindex: POST returned ${String(resp.status())}: ${body}`);
  }
}

/**
 * Root-level tree row order, sorted by visual top position rather than raw DOM
 * order — react-arborist recycles virtualized nodes, and a user only perceives the
 * visual order.
 *
 * Keyed on the rendered LABEL, not the row id: a `mode: "full"` admin/reindex mints
 * a fresh UUID for every note lacking a prior known ID, so an id captured from a
 * POST /notes response does not survive one. The filename-derived label does.
 *
 * Excludes the "scratchpad" note every fresh vault ships with — its real spawn-time
 * timestamps would land unpredictably among the seeded ones.
 */
async function getRootRowOrder(page: Page): Promise<Array<{ kind: string; label: string }>> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Notes navigation"]');
    if (!nav) return [];
    const rows = Array.from(nav.querySelectorAll("[data-tree-row]")) as HTMLElement[];
    return rows
      .map((el) => ({
        kind: el.getAttribute("data-tree-row-kind") ?? "",
        label: el.querySelector("[data-tree-row-label]")?.textContent ?? "",
        top: el.getBoundingClientRect().top,
      }))
      .filter((r) => r.label !== "scratchpad")
      .sort((a, b) => a.top - b.top)
      .map(({ kind, label }) => ({ kind, label }));
  });
}

/**
 * Search-result row titles in visual order, scoped to the Notes navigation
 * nav (the Search panel mounts inside the same nav as the Files tree — see
 * header comment). Distinguishes SidebarSearchResultRow's "Open note: X"
 * aria-label rows from LinkedMentionsPanel's identically-labelled rows,
 * which live in the right rail, outside this nav.
 */
async function getSearchResultTitlesInOrder(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Notes navigation"]');
    if (!nav) return [];
    const rows = Array.from(
      nav.querySelectorAll('[role="button"][aria-label^="Open note: "]'),
    ) as HTMLElement[];
    return rows
      .map((el) => ({
        title: (el.getAttribute("aria-label") ?? "").replace(/^Open note: /, ""),
        top: el.getBoundingClientRect().top,
      }))
      .sort((a, b) => a.top - b.top)
      .map((r) => r.title);
  });
}

// ─── SORT-01/03 — notes sort: folder-grouping + reorder + per-vault persist ──

test.describe("@phase29 @sort SORT-01/03: notes sort menu reorders + persists per vault", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Name (Z→A) and Modified (new→old) reorder notes while folders stay A→Z first; the choice survives reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    // folders always precede notes and stay A→Z regardless of order.
    const deltaPath = await apiCreateFolder(page, jasper.baseURL, "delta");
    const zuluPath = await apiCreateFolder(page, jasper.baseURL, "zulu");
    await apiCreateNote(page, jasper.baseURL, "inner-delta.md", deltaPath, "# inner-delta\n");
    await apiCreateNote(page, jasper.baseURL, "inner-zulu.md", zuluPath, "# inner-zulu\n");

    // Three root notes with distinct, controlled mtimes (bravo newest, alpha
    // oldest) so "Modified (new → old)" has a single unambiguous order.
    const T = 1_700_000_000;
    await seedNoteWithMtime(
      page,
      jasper.baseURL,
      jasper.dataDir,
      "alpha.md",
      "# alpha\n\nRoot note alpha.\n",
      T + 1000,
    );
    await seedNoteWithMtime(
      page,
      jasper.baseURL,
      jasper.dataDir,
      "bravo.md",
      "# bravo\n\nRoot note bravo.\n",
      T + 3000,
    );
    await seedNoteWithMtime(
      page,
      jasper.baseURL,
      jasper.dataDir,
      "charlie.md",
      "# charlie\n\nRoot note charlie.\n",
      T + 2000,
    );

    // mode:"full" walks every file so the custom mtimes above are reflected
    // in the index before the tree is ever fetched.
    await triggerFullReindex(page, jasper.baseURL);

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await tabRow(page).getByRole("button", { name: "Notes", exact: true }).click();

    await expect(notesNav(page).locator('[data-tree-row-label]', { hasText: "alpha" })).toBeVisible({
      timeout: 10_000,
    });

    // Name (Z → A): folders delta, zulu (always A→Z) then notes Z→A.
    await page.getByRole("button", { name: "Sort notes" }).click();
    await page.getByRole("menuitem", { name: "Name (Z → A)" }).click();

    await expect
      .poll(() => getRootRowOrder(page), { timeout: 5_000 })
      .toEqual([
        { kind: "folder", label: "delta" },
        { kind: "folder", label: "zulu" },
        { kind: "note", label: "charlie" },
        { kind: "note", label: "bravo" },
        { kind: "note", label: "alpha" },
      ]);

    // Modified (new → old): bravo(3000) > charlie(2000) > alpha(1000);
    // folders unaffected.
    await page.getByRole("button", { name: "Sort notes" }).click();
    await page.getByRole("menuitem", { name: "Modified (new → old)" }).click();

    const expectedModifiedOrder = [
      { kind: "folder", label: "delta" },
      { kind: "folder", label: "zulu" },
      { kind: "note", label: "bravo" },
      { kind: "note", label: "charlie" },
      { kind: "note", label: "alpha" },
    ];
    await expect.poll(() => getRootRowOrder(page), { timeout: 5_000 }).toEqual(expectedModifiedOrder);

    // SORT-03: reload — the choice is persisted per vault in
    // <vault>/.jasper/workspace.json, restored via GET on mount.
    await page.reload();
    await waitForConnected(page);
    await expect
      .poll(() => getRootRowOrder(page), { timeout: 8_000 })
      .toEqual(expectedModifiedOrder);
  });
});

// ─── SORT-02 — search-result sort: true backend re-order, not a reshuffle ───

test.describe("@phase29 @search-sort SORT-02: search-result sort re-orders via the real backend sort param", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("switching Relevance → Modified → Created changes the result order to match the SQL ORDER BY", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    // Real, un-faked timestamps only — no admin/reindex and no fs.utimes
    // here (see sleepMs doc: a `mode:"full"` reindex mints a fresh id AND
    // homogenizes the SQL `updated_at` column to the reindex instant for
    // every row, which would make "Modified" un-testable; separately,
    // fs.utimes-ing a file's mtime to a point BEFORE its real birthtime
    // gets silently clamped by APFS, which also drags birthtime down with
    // it). Instead: create the three notes ~1.1s apart (birthtime/
    // created_at ascend alpha→bravo→charlie), then re-PUT them in the
    // REVERSE order, also ~1.1s apart (updated_at/mtime then ascend
    // charlie→bravo→alpha) — two independent, genuinely real orderings
    // from one natural create-then-edit user flow.
    const alphaId = await apiCreateNote(
      page,
      jasper.baseURL,
      "zephalpha.md",
      "",
      "# zephalpha\n\nzephyrus appears once here.\n",
    );
    await sleepMs(1100);
    const bravoId = await apiCreateNote(
      page,
      jasper.baseURL,
      "zephbravo.md",
      "",
      "# zephbravo\n\nzephyrus zephyrus appears twice here.\n",
    );
    await sleepMs(1100);
    const charlieId = await apiCreateNote(
      page,
      jasper.baseURL,
      "zephcharlie.md",
      "",
      "# zephcharlie\n\nzephyrus zephyrus zephyrus three times here.\n",
    );

    // Re-save in reverse creation order so "modified" diverges from
    // "created": charlie (oldest re-save) → bravo → alpha (newest re-save).
    await sleepMs(1100);
    await apiUpdateNoteContent(
      page,
      jasper.baseURL,
      charlieId,
      "# zephcharlie\n\nzephyrus zephyrus zephyrus three times here.\n",
    );
    await sleepMs(1100);
    await apiUpdateNoteContent(
      page,
      jasper.baseURL,
      bravoId,
      "# zephbravo\n\nzephyrus zephyrus appears twice here.\n",
    );
    await sleepMs(1100);
    await apiUpdateNoteContent(
      page,
      jasper.baseURL,
      alphaId,
      "# zephalpha\n\nzephyrus appears once here.\n",
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await tabRow(page).getByRole("button", { name: "Search", exact: true }).click();

    const input = searchPanelInput(page);
    // The earlier sidebar tab row (unlike the old ribbon Search toggle) does
    // NOT auto-focus the input on panel switch — a real click is required.
    await input.click();
    await input.fill("zephyrus");

    // Relevance (default): highest keyword-density note ranks first
    // (bm25 + recency blend default branch).
    await expect
      .poll(() => getSearchResultTitlesInOrder(page), { timeout: 5_000 })
      .toEqual(["zephcharlie", "zephbravo", "zephalpha"]);

    // Modified (new → old): n.updated_at DESC — alpha (re-saved last) first.
    await page.getByRole("button", { name: "Sort search results" }).click();
    await page.getByRole("menuitem", { name: "Modified (new → old)" }).click();
    await expect
      .poll(() => getSearchResultTitlesInOrder(page), { timeout: 5_000 })
      .toEqual(["zephalpha", "zephbravo", "zephcharlie"]);

    // Created (new → old): true FS birthtime/created_at DESC — charlie
    // (created last) first, independent of the re-save order above (the
    // uses COALESCE(NULLIF(birthtime_unix,0), created_at), never mtime).
    await page.getByRole("button", { name: "Sort search results" }).click();
    await page.getByRole("menuitem", { name: "Created (new → old)" }).click();
    await expect
      .poll(() => getSearchResultTitlesInOrder(page), { timeout: 5_000 })
      .toEqual(["zephcharlie", "zephbravo", "zephalpha"]);
  });
});

// ─── HIST-01/02 — recent-searches hints: MRU, dedupe, keyboard nav, persist ─

test.describe("@phase29 @history HIST-01/02: search history hints — MRU, keyboard nav, dedupe, persistence", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("committed searches build MRU history; hints are keyboard-navigable; re-running a hint dedupes it to the top; history survives reload", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    await apiCreateNote(
      page,
      jasper.baseURL,
      "meetingroom.md",
      "",
      "# meetingroom\n\nteam meeting notes here.\n",
    );
    await apiCreateNote(
      page,
      jasper.baseURL,
      "budgetplan.md",
      "",
      "# budgetplan\n\nannual budget plan here.\n",
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await tabRow(page).getByRole("button", { name: "Search", exact: true }).click();

    const input = searchPanelInput(page);
    // The earlier sidebar tab row (unlike the old ribbon Search toggle) does
    // NOT auto-focus the input on panel switch — a real click is required
    // (it also fires the onFocus handler that opens the hints layer).
    await input.click();

    // Enter-committed searches only. Commit #1 — "meeting".
    await input.fill("meeting");
    await expect(page.getByRole("button", { name: "Open note: meetingroom" })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press("Enter");

    // Commit #2 — "budget".
    await input.fill("");
    await input.fill("budget");
    await expect(page.getByRole("button", { name: "Open note: budgetplan" })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press("Enter");

    // clearing the query (prefix "" matches everything) + refocusing
    // shows both entries, MRU order (most-recent commit first).
    await input.fill("");
    await input.click();
    const listbox = recentSearchesListbox(page);
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    const hintOptions = listbox.getByRole("option");
    await expect(hintOptions).toHaveCount(2);
    await expect.poll(() => hintOptions.allTextContents()).toEqual(["budget", "meeting"]);

    // ArrowDown moves the keyboard highlight to the next hint; Enter
    // re-runs the selected hint (sets the query, closes the hints layer).
    await page.keyboard.press("ArrowDown");
    await expect(hintOptions.nth(1)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(input).toHaveValue("meeting");

    // re-running an existing query moves it back to the MRU top.
    // Real blur (Tab away) + refocus (click) so the hints layer re-mounts;
    // clear the query again (the re-run left "meeting" in the input, which
    // would prefix-filter the hints layer down to just that one entry).
    await page.keyboard.press("Tab");
    await input.click();
    await input.fill("");
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => hintOptions.allTextContents()).toEqual(["meeting", "budget"]);

    // HIST-02: history survives a full page reload (durable localStorage,
    // vault-namespaced).
    await page.reload();
    await waitForConnected(page);
    await expect(searchPanelInput(page)).toBeVisible({ timeout: 8_000 });
    await searchPanelInput(page).click();
    const listboxAfterReload = recentSearchesListbox(page);
    await expect(listboxAfterReload).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(() => listboxAfterReload.getByRole("option").allTextContents())
      .toEqual(["meeting", "budget"]);
  });

  test("mouse-only: clicking a hint row re-runs it; clicking a row's X removes it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    // Self-contained fixture notes (this test must pass standalone —
    // fresh browser context means fresh localStorage history too).
    await apiCreateNote(
      page,
      jasper.baseURL,
      "clickone.md",
      "",
      "# clickone\n\nclickone target text.\n",
    );
    await apiCreateNote(
      page,
      jasper.baseURL,
      "clicktwo.md",
      "",
      "# clicktwo\n\nclicktwo target text.\n",
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await tabRow(page).getByRole("button", { name: "Search", exact: true }).click();

    const input = searchPanelInput(page);
    await input.click();

    await input.fill("clickone");
    await expect(page.getByRole("button", { name: "Open note: clickone" })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press("Enter");
    await input.fill("");
    await input.fill("clicktwo");
    await expect(page.getByRole("button", { name: "Open note: clicktwo" })).toBeVisible({
      timeout: 5_000,
    });
    await page.keyboard.press("Enter");

    await input.fill("");
    const listbox = recentSearchesListbox(page);
    await expect(listbox).toBeVisible({ timeout: 5_000 });

    // a REAL mouse press fires mousedown (which blurs the input and
    // unmounts the dropdown unless default-prevented) before click ever
    // lands. Synthetic unit-test clicks skip that focus cycle and
    // false-pass, so this must stay a real-mouse assertion.
    await listbox.getByRole("option").filter({ hasText: "clickone" }).click();
    await expect(input).toHaveValue("clickone");
    await expect(listbox).not.toBeVisible();

    // Blur + refocus to re-open the layer, then clear so both entries show.
    await page.keyboard.press("Tab");
    await input.click();
    await input.fill("");
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    const hintOptions = listbox.getByRole("option");
    await expect.poll(() => hintOptions.allTextContents()).toEqual(["clickone", "clicktwo"]);

    // hover reveals the row's X; a real mouse click on it removes just
    // that entry while the dropdown stays open and the input keeps focus.
    await hintOptions.filter({ hasText: "clicktwo" }).hover();
    await listbox.getByRole("button", { name: 'Remove "clicktwo" from search history' }).click();
    await expect.poll(() => hintOptions.allTextContents()).toEqual(["clickone"]);
    await expect(listbox).toBeVisible();
    await expect(input).toBeFocused();
  });
});
