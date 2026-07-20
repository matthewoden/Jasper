/**
 * Phase 28 UAT — Quick Switcher Reconciliation (QUICK-01..04).
 *
 * Closes the Wave 0 E2E gap identified in 28-VALIDATION.md: proves the
 * restyled Cmd+O quick switcher end-to-end against the embedded binary.
 *
 *   QUICK-01  Restyle smoke: `#quick-switcher-listbox` renders; rows carry
 *             NO "Note" kind badge (D-14); a matched query highlights
 *             characters via inline `<span>` nodes (D-15); the input
 *             placeholder reads "Find or create a note…"; the always-on
 *             footer legend (D-13) shows "open"/"create"/"split".
 *   QUICK-02  Shift+Enter (D-05/D-07/D-09): a novel query creates a note by
 *             that name and opens it; an existing title (different case)
 *             opens the existing note instead of creating a duplicate; the
 *             synthetic "Create "{query}"" row (`#qs-option-create`) only
 *             appears for a novel, non-empty query.
 *   QUICK-03  Cmd/Ctrl+Shift+Enter (D-10/D-11): opens the selected note in a
 *             NEW split — leaf-pane count increases by 1, and the new pane
 *             becomes active with that note visible.
 *   QUICK-04  Cmd+K is retired (D-02, mode="all" removed outright) — it must
 *             open nothing at all.
 *
 * Harness mirrors phase22/26/27-uat.spec.ts: spawnJasper() per describe
 * block against a rebuilt binary, real page interactions, @phase28 tag.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — the spec runs against the EMBEDDED binary.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive assertion uses
 * expect/expect.poll (memory no-flaky-tests).
 */
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { test, expect, type Page, type Locator } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected, apiCreateNote } from "./helpers/phase7Helpers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ARTIFACTS_DIR = path.join(__dirname, ".artifacts");

const MOD = process.platform === "darwin" ? "Meta" : "Control";

function ensureArtifactsDir(): void {
  if (!fs.existsSync(ARTIFACTS_DIR)) {
    fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  }
}

/** Press the quick-switcher shortcut (Cmd/Ctrl+O). */
async function pressCmdO(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+o`);
}

/** Press the retired unified-palette shortcut (Cmd/Ctrl+K) — QUICK-04 expects a no-op. */
async function pressCmdK(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+k`);
}

function noteRow(page: Page, id: string): Locator {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row to be visible first. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

/** All leaf panes currently rendered (mirrors phase26-divider-uat.spec.ts's selector contract). */
function leafPanes(page: Page): Locator {
  return page.locator('[data-testid="leaf-pane"]');
}

/**
 * The active pane's editor title element. App.tsx keeps one EditorPane
 * mounted per open tab (hidden via CSS, never unmounted), so a plain
 * `:visible` filter is ambiguous once a split makes >1 pane simultaneously
 * visible on screen -- scope to the pane LeafPane marks
 * `data-active-pane="true"` (mirrors phase22-uat.spec.ts's CR-01 rationale,
 * extended for the multi-pane case Phase 25/26 introduced).
 */
function activeEditorTitle(page: Page): Locator {
  return page
    .locator('[data-testid="leaf-pane"][data-active-pane="true"]')
    .getByTestId("editor-title-element")
    .and(page.locator(":visible"));
}

/** Fetch the live tree from the API; flattened note-title lookups for duplicate-detection assertions. */
async function fetchNoteTitles(page: Page, baseURL: string, title: string): Promise<number> {
  const resp = await page.request.get(`${baseURL}/api/v1/tree`);
  const body = (await resp.json()) as {
    root: Array<{ kind: string; title?: string; children?: unknown[] }>;
  };
  let count = 0;
  const visit = (nodes: Array<{ kind: string; title?: string; children?: unknown[] }>): void => {
    for (const n of nodes) {
      if (n.kind === "note" && n.title === title) count++;
      if (n.kind === "folder" && Array.isArray(n.children)) {
        visit(n.children as Array<{ kind: string; title?: string; children?: unknown[] }>);
      }
    }
  };
  visit(body.root);
  return count;
}

// ─── QUICK-01 — restyle smoke ────────────────────────────────────────────────

test.describe("@phase28 QUICK-01: quick switcher restyle smoke", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    ensureArtifactsDir();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+O opens the restyled switcher: listbox renders, no kind badge, matched query highlights characters, placeholder + footer legend copy", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await apiCreateNote(
      page,
      jasper.baseURL,
      "restylealphaqs.md",
      "",
      "# restylealphaqs\n\nBody text for the restyle smoke test.\n",
    );
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressCmdO(page);
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // D-14: listbox exists with the contracted id/role and carries no kind badge.
    const listbox = dialog.locator("#quick-switcher-listbox");
    await expect(listbox).toBeVisible({ timeout: 5_000 });
    await expect(listbox).toHaveAttribute("role", "listbox");
    await expect(listbox.getByText("Note", { exact: true })).toHaveCount(0);

    // Placeholder copy (Copywriting Contract).
    await expect(dialog.getByPlaceholder("Find or create a note…")).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "phase28-switcher-empty.png"),
      fullPage: false,
    });

    // D-15: a matching query highlights the matched characters via inline <span>s.
    await dialog.getByRole("combobox").fill("restylealphaqs");
    const matchedRow = dialog.locator('[data-row-kind="note"]').filter({ hasText: "restylealphaqs" }).first();
    await expect(matchedRow).toBeVisible({ timeout: 5_000 });
    await expect(matchedRow.locator("span").first()).toBeVisible();
    // Still no kind badge on the matched row.
    await expect(matchedRow.getByText("Note", { exact: true })).toHaveCount(0);

    // D-13: the always-on footer legend, sibling AFTER the scrollable listbox.
    await expect(dialog.getByText("open", { exact: true })).toBeVisible();
    await expect(dialog.getByText("create", { exact: true })).toBeVisible();
    await expect(dialog.getByText("split", { exact: true })).toBeVisible();

    await page.screenshot({
      path: path.join(ARTIFACTS_DIR, "phase28-switcher-query.png"),
      fullPage: false,
    });
  });
});

// ─── QUICK-02 — Shift+Enter create / no-duplicate / create-row visibility ───

test.describe("@phase28 QUICK-02: Shift+Enter create-or-open", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Shift+Enter on a novel query creates + opens a note; the same title differently-cased opens the existing note without duplicating; the create row only appears for a novel non-empty query", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const novelTitle = "novelnoteqs2802";

    // Novel query -> Shift+Enter creates and opens it.
    await pressCmdO(page);
    let dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("combobox").fill(novelTitle);
    await expect(dialog.locator("#qs-option-create")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Shift+Enter");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText(novelTitle, { timeout: 5_000 });
    await expect
      .poll(() => fetchNoteTitles(page, jasper.baseURL, novelTitle), { timeout: 5_000 })
      .toBe(1);

    // The create row disappears once the exact title now exists (case-insensitive
    // exact-match, D-07) -- typing the SAME casing shows no create row.
    await pressCmdO(page);
    dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("combobox").fill(novelTitle);
    await expect(dialog.locator("#qs-option-create")).toHaveCount(0);

    // Differently-cased query for the SAME title -> Shift+Enter opens the
    // EXISTING note (D-07) rather than creating a duplicate; no create row
    // for this query either.
    const differentCase = novelTitle.toUpperCase();
    await dialog.getByRole("combobox").fill(differentCase);
    await expect(dialog.locator("#qs-option-create")).toHaveCount(0);
    await page.keyboard.press("Shift+Enter");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    // The existing note's original casing is preserved -- no duplicate/rename.
    await expect(activeEditorTitle(page)).toHaveText(novelTitle, { timeout: 5_000 });
    await expect
      .poll(() => fetchNoteTitles(page, jasper.baseURL, novelTitle), { timeout: 5_000 })
      .toBe(1);
    await expect
      .poll(() => fetchNoteTitles(page, jasper.baseURL, differentCase), { timeout: 5_000 })
      .toBe(0);

    // A genuinely novel query (not the seeded title) shows the create row again.
    await pressCmdO(page);
    dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("combobox").fill(`${novelTitle}-part2`);
    await expect(dialog.locator("#qs-option-create")).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
  });
});

// ─── QUICK-03 — Cmd/Ctrl+Shift+Enter opens the selected note in a new split ──

test.describe("@phase28 QUICK-03: Cmd/Ctrl+Shift+Enter opens a new split", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("selecting a note row then Cmd/Ctrl+Shift+Enter increases the pane count by 1 and opens the note in the new split", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    const activeId = await apiCreateNote(
      page,
      jasper.baseURL,
      "split-active-qs2803.md",
      "",
      "# split-active-qs2803\n\nAlready-open note in the single starting pane.\n",
    );
    const targetId = await apiCreateNote(
      page,
      jasper.baseURL,
      "split-target-qs2803.md",
      "",
      "# split-target-qs2803\n\nTarget note that gets opened in a new split.\n",
    );
    void targetId;
    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    await openNoteFromTree(page, activeId);
    await expect(leafPanes(page)).toHaveCount(1);

    await pressCmdO(page);
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await dialog.getByRole("combobox").fill("split-target-qs2803");
    const targetRow = dialog
      .locator('[data-row-kind="note"]')
      .filter({ hasText: "split-target-qs2803" });
    await expect(targetRow).toHaveCount(1, { timeout: 5_000 });
    // Only one match for this query, so it's already selectedIdx 0 -- no arrow
    // navigation needed. Confirm it carries the selected ARIA state before activating.
    await expect(targetRow).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press(`${MOD}+Shift+Enter`);
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(leafPanes(page)).toHaveCount(2, { timeout: 5_000 });
    await expect(activeEditorTitle(page)).toHaveText("split-target-qs2803", {
      timeout: 5_000,
    });
  });
});

// ─── QUICK-04 — Cmd+K is retired: opens nothing ──────────────────────────────

test.describe("@phase28 QUICK-04: Cmd+K opens nothing", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+K is unbound (D-02, mode='all' retired) -- no palette dialog opens", async ({
    page,
  }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressCmdK(page);
    // Give any (incorrect) async dialog mount a real chance to appear before
    // asserting absence -- poll rather than a fixed sleep.
    await expect
      .poll(() => page.getByRole("dialog").count(), { timeout: 1_000 })
      .toBe(0);

    // Sanity: the OTHER quick-switcher entrances still work in the same
    // session, proving Cmd+K's absence isn't a broader palette-wiring bug.
    await pressCmdO(page);
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible({
      timeout: 5_000,
    });
  });
});
