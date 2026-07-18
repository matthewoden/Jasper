/**
 * Phase 26 UAT — Per-Pane Find/Replace bar (WS-09, D-01..D-04).
 *
 * Covers the observable browser behaviors for the custom Find/Replace bar
 * built in Plan 04: Cmd+F opens a find-only bar; Cmd+Opt+F upgrades to
 * find+replace; live match count + highlight-all; Replace All mutates the
 * document (reversible via CM6 undo); Esc closes the bar and returns focus
 * to the editor; and per-pane scoping (opening Find in one pane never
 * affects a sibling pane's find state), matching D-01's "per-view CM6 state
 * is per-pane for free" contract.
 *
 * Selector contract:
 *   - Leaf pane:          [data-testid="leaf-pane"]      (Phase 25)
 *   - Find bar container: [data-testid="find-bar"]
 *   - Match count label:  [data-testid="find-match-count"]
 *
 * Split actions route through the command palette (Cmd+P, mode="commands")
 * rather than the raw Cmd+\ shortcut — mirrors phase25-uat.spec.ts's
 * rationale (App-level shortcuts no-op while a contenteditable has focus;
 * Cmd+P does not).
 *
 * Discipline: ZERO fixed sleeps; every timing-sensitive step uses a
 * web-first assertion (expect / expect.poll). Run with `--repeat-each=3`
 * to prove non-flake (no-flaky-tests memory), matching every other
 * timing-sensitive scenario in this suite.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const PARITY_SHOTS_DIR = path.join(repoRoot, ".parity-shots");

// ─── Selector contract ────────────────────────────────────────────────────────

const SELECTORS = {
  leafPane: '[data-testid="leaf-pane"]',
  findBar: '[data-testid="find-bar"]',
  findMatchCount: '[data-testid="find-match-count"]',
  breadcrumb: '[data-testid="note-breadcrumb"]',
  cmHostShell: '[data-testid="cm-host-shell"]',
} as const;

// IMPORTANT: Playwright's `devices["Desktop Chrome"]` (playwright.config.ts's
// project) hard-codes a Windows userAgent/platform ("Win32") REGARDLESS of the
// host OS running the test — confirmed via `navigator.platform` inside the
// page. CM6's `Mod-` keymap normalization resolves against the IN-PAGE
// `navigator.platform` at binding-build time (@codemirror/view's
// `currentPlatform`), not the host OS, so every "Mod-X" binding in this
// harness resolves to "Ctrl-X" — pressing "Meta+f" (Cmd+F) NEVER matches,
// only "Control+f" does, on every host (Mac dev machine, Linux CI). This is
// why Cmd+B/I's own e2e coverage (phase7-uat.spec.ts) is `test.skip`'d and
// why phase25-uat.spec.ts's `Meta+z` undo test passes only because Chrome's
// NATIVE contenteditable undo (not CM6's own Mod-z keymap) reverts the last
// native keystroke — a fallback that does NOT exist for Find (no native
// "find in a contenteditable" default action), so Find/Replace MUST be
// exercised with the Control- combo that actually matches CM6's resolved
// keymap in this harness.
const FIND_KEY = "Control+f";
const FIND_REPLACE_KEY = "Control+Alt+f";
const UNDO_KEY = "Control+z";

// ─── Shared helpers (mirrors phase25-uat.spec.ts's isolation pattern) ────────

/**
 * Spawn a binary with an isolated JASPER_APP_HOME so GET /vault/current
 * returns THIS test's ephemeral vault, not whatever a parallel worker last
 * opened in the shared default app home.
 */
async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p26-apphome-"));
  const jasper = await spawnJasper({ env: { JASPER_APP_HOME: appHome } });
  return { jasper, appHome };
}

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a note via the API; returns its UUID. */
async function apiCreateNote(
  page: Page,
  baseURL: string,
  title: string,
  parentPath = "",
): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: parentPath, title },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateNote ${title}: ${String(resp.status())} ${body}`);
  }
  return ((await resp.json()) as { id: string }).id;
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

/** All leaf panes currently rendered, in tree order (a before b, per paneTree.ts). */
function leafPanes(page: Page): Locator {
  return page.locator(SELECTORS.leafPane);
}

/**
 * Makes `leaf` the active pane (D-04: click anywhere in a leaf's chrome
 * focuses it) AND focuses its editor — convenient for pressing Cmd+F right
 * after, since jasperKeymap's findBarKeymap only fires while THAT pane's
 * EditorView has DOM focus.
 */
async function activatePane(leaf: Locator): Promise<void> {
  await leaf.getByTestId("cm-host-shell").click();
}

/**
 * Opens the command palette (Cmd+P, mode="commands") and activates the
 * command whose label matches `label` exactly.
 */
async function runCommand(page: Page, label: string): Promise<void> {
  await page.keyboard.press("Meta+p");
  const input = page.getByPlaceholder("Type a command…");
  await expect(input).toBeVisible({ timeout: 5_000 });
  await input.fill(label);
  const row = page.locator('[data-row-kind="cmd"]').filter({ hasText: label }).first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Resolves a bounding box, polling until layout settles to non-zero dimensions. */
async function stableBox(locator: Locator): Promise<Box> {
  let box: Box | null = null;
  await expect
    .poll(
      async () => {
        box = await locator.boundingBox();
        return box !== null && box.width > 0 && box.height > 0;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  if (box === null) throw new Error("bounding box unavailable");
  return box;
}

// ─── @find — Find-only bar, match count, highlight-all ───────────────────────

test.describe("@find phase26 Find/Replace bar", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
    fs.mkdirSync(PARITY_SHOTS_DIR, { recursive: true });
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("Cmd+F opens a find-only bar with live match count + highlight; Cmd+Opt+F upgrades to Replace All; undo reverts; Esc returns focus", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "find-alpha");
    await openNoteFromTree(page, idA);

    const editor = page.locator(".cm-content:visible");
    await expect(editor).toBeVisible({ timeout: 8_000 });
    await editor.click();
    await page.keyboard.press("End");
    await page.keyboard.type("\napple banana apple cherry apple");
    await expect(editor).toContainText("apple banana apple cherry apple");

    // Cmd+F opens the find-only bar — no replace input present. jasperKeymap's
    // findBarKeymap is bound on the CM6 EditorView itself, so it only fires
    // while THIS pane's `.cm-content` has DOM focus (by design — D-02 scopes
    // the shortcut to the active editor, not globally).
    await page.keyboard.press(FIND_KEY);
    const bar = page.locator(SELECTORS.findBar);
    await expect(bar).toBeVisible();
    await expect(bar.getByPlaceholder("Replace with")).toHaveCount(0);

    const findInput = bar.getByPlaceholder("Find");

    // A present term reads "3 matches" and highlights all 3.
    await findInput.fill("apple");
    await expect(bar.locator(SELECTORS.findMatchCount)).toHaveText("3 matches");
    await expect(page.locator(".cm-jasper-search-match")).toHaveCount(3);

    // An absent term reads "0 matches".
    await findInput.fill("zzz-not-present");
    await expect(bar.locator(SELECTORS.findMatchCount)).toHaveText("0 matches");

    // Esc closes the bar and returns focus to the editor (D-02) — also
    // re-establishes editor focus so the NEXT shortcut (Cmd+Opt+F) is
    // dispatched against `.cm-content`, not the find bar's own input.
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest(".cm-content") !== null),
      )
      .toBe(true);

    // Cmd+Opt+F opens a FRESH bar in find+replace mode.
    await page.keyboard.press(FIND_REPLACE_KEY);
    await expect(bar).toBeVisible();
    await expect(bar.getByPlaceholder("Replace with")).toBeVisible();
    await expect(bar.getByText("Replace", { exact: true })).toBeVisible();
    await expect(bar.getByText("Replace All", { exact: true })).toBeVisible();

    await bar.getByPlaceholder("Find").fill("apple");
    await expect(bar.locator(SELECTORS.findMatchCount)).toHaveText("3 matches");
    await bar.getByPlaceholder("Replace with").fill("APPLE");
    await bar.getByText("Replace All", { exact: true }).click();
    await expect(editor).toContainText("APPLE banana APPLE cherry APPLE");
    await expect(editor).not.toContainText("apple");

    // Replace All is reversible via CM6 undo (T-26-04-Integrity) — refocus
    // the editor first (the click also re-targets this pane, D-04).
    await editor.click();
    await page.keyboard.press(UNDO_KEY);
    await expect(editor).toContainText("apple banana apple cherry apple");

    // Esc closes the bar and returns focus to the editor (D-02). Escape is
    // handled by the bar's OWN container (bubble-phase from its descendant
    // inputs) — click back into the bar first so the keydown actually
    // reaches it (mirrors realistic UX: the user is interacting with the
    // bar, not the editor, when they press Esc to dismiss it).
    await bar.getByPlaceholder("Find").click();
    await page.keyboard.press("Escape");
    await expect(bar).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(() => document.activeElement?.closest(".cm-content") !== null),
      )
      .toBe(true);
  });

  test("per-pane scoping: opening Find in one pane does not render a bar in the sibling pane", async ({
    page,
  }) => {
    test.slow();
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "find-split");
    await openNoteFromTree(page, idA);

    // Split right clones the active note into a new sibling leaf (P25 D-15)
    // — both leaves show the SAME note, matching "the same note open in
    // both panes" per the scenario requirement.
    await runCommand(page, "Split right");
    await expect(leafPanes(page)).toHaveCount(2);

    const leftLeaf = leafPanes(page).nth(0);
    const rightLeaf = leafPanes(page).nth(1);

    await activatePane(leftLeaf);
    await page.keyboard.press(FIND_KEY);

    await expect(leftLeaf.locator(SELECTORS.findBar)).toBeVisible();
    await expect(rightLeaf.locator(SELECTORS.findBar)).toHaveCount(0);

    // The left leaf's find state is independent — typing there does not
    // leak into the right leaf, which never mounted a bar at all.
    await leftLeaf.locator(SELECTORS.findBar).getByPlaceholder("Find").fill("find-split");
    await expect(rightLeaf.locator(SELECTORS.findBar)).toHaveCount(0);
  });

  test("the find bar renders below the breadcrumb and above the note body (P26 polish, UI-SPEC line 151)", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);

    const idA = await apiCreateNote(page, jasper.baseURL, "find-position-alpha");
    await openNoteFromTree(page, idA);

    const leaf = leafPanes(page).first();
    await activatePane(leaf);
    await page.keyboard.press(FIND_KEY);

    const bar = leaf.locator(SELECTORS.findBar);
    await expect(bar).toBeVisible();

    const breadcrumbBox = await stableBox(leaf.locator(SELECTORS.breadcrumb));
    const findBarBox = await stableBox(bar);
    const bodyBox = await stableBox(leaf.locator(SELECTORS.cmHostShell));

    expect(breadcrumbBox.y).toBeLessThan(findBarBox.y);
    expect(findBarBox.y).toBeLessThan(bodyBox.y);

    await page.screenshot({
      path: path.join(PARITY_SHOTS_DIR, "phase26-find-position.png"),
    });
  });
});
