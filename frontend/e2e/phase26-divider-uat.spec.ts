/**
 * Phase 26 Plan 03 — Divider resize (WS-05).
 *
 * Proves the interactive pane divider end-to-end against a rebuilt binary:
 *   1. Resize (D-13): dragging the divider live-reflows both panes.
 *   2. Clamp (D-14): dragging past a pane's edge stops at the 160px minimum
 *      rather than crushing the pane.
 *   3. Persistence (D-13): the final ratio survives a full page reload via
 *      the existing debounced per-vault layout write.
 *
 * Selector contract (mirrors phase25-uat.spec.ts):
 *   - Leaf pane:            [data-testid="leaf-pane"]
 *   - Divider hit zone:     [data-testid="pane-divider-handle"]
 *
 * Drag discipline (memory verify-dnd-with-real-mouse, no-flaky-tests): every
 * drag is driven with real `page.mouse.move/down/up` (intermediate moves
 * included) against a freshly built binary — never synthetic DragEvents,
 * which false-pass on this kind of pointer-driven interaction. ZERO fixed
 * sleeps; every timing-sensitive step (debounced 250ms persistence write,
 * reload restore) uses expect.poll / web-first assertions. Scenario 3 is
 * timing-sensitive and is run under --repeat-each=3 to prove non-flake.
 */
import { test, expect, type Page, type Locator } from "@playwright/test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..");
const SHOTS_DIR = path.join(repoRoot, ".parity-shots");

// ─── Selector contract ────────────────────────────────────────────────────────

const SELECTORS = {
  leafPane: '[data-testid="leaf-pane"]',
  paneDividerHandle: '[data-testid="pane-divider-handle"]',
} as const;

// ─── Shared helpers (mirrors phase25-uat.spec.ts's isolation pattern) ────────

/**
 * Spawn a binary with an isolated JASPER_APP_HOME so GET /vault/current
 * returns THIS test's ephemeral vault, matching phase25-uat.spec.ts's
 * rationale (the vault path seeds the localStorage layout-persistence key).
 */
async function spawnIsolated(): Promise<{ jasper: JasperHandle; appHome: string }> {
  const appHome = fs.mkdtempSync(path.join(os.tmpdir(), "jasper-p26-divider-apphome-"));
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
async function apiCreateNote(page: Page, baseURL: string, title: string): Promise<string> {
  const resp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: "", title },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateNote ${title}: ${String(resp.status())} ${body}`);
  }
  return ((await resp.json()) as { id: string }).id;
}

/** All leaf panes currently rendered, in tree order (a before b, per paneTree.ts). */
function leafPanes(page: Page): Locator {
  return page.locator(SELECTORS.leafPane);
}

/**
 * Opens the command palette (Cmd+P, mode="commands") and activates the
 * command whose label matches `label` exactly — same routing rationale as
 * phase25-uat.spec.ts (Cmd+P is not guarded by the typing-target no-op that
 * the raw split shortcut is).
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

/**
 * Creates a two-pane row-split layout: opens a fresh note, then splits right
 * via the palette. Returns the two leaf-pane locators in tree order.
 */
async function setupSplit(page: Page, baseURL: string): Promise<{ left: Locator; right: Locator }> {
  const id = await apiCreateNote(
    page,
    baseURL,
    `divider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  await openNoteFromTree(page, id);
  await expect(leafPanes(page)).toHaveCount(1);
  await runCommand(page, "Split right");
  await expect(leafPanes(page)).toHaveCount(2);
  return { left: leafPanes(page).nth(0), right: leafPanes(page).nth(1) };
}

/**
 * Drags the pane-divider handle from its current position to `targetClientX`
 * using real mouse events with intermediate moves (memory
 * verify-dnd-with-real-mouse) — proving a continuous drag, not a single jump.
 */
async function dragDividerTo(page: Page, targetClientX: number): Promise<void> {
  const handle = page.locator(SELECTORS.paneDividerHandle);
  const box = await handle.boundingBox();
  if (!box) throw new Error("pane-divider-handle has no bounding box");
  const startX = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(startX, y);
  await page.mouse.down();
  const steps = 10;
  for (let i = 1; i <= steps; i++) {
    const x = startX + ((targetClientX - startX) * i) / steps;
    await page.mouse.move(x, y, { steps: 1 });
  }
  await page.mouse.up();
}

// ─── WS-05 / D-13 — live resize ──────────────────────────────────────────────

test.describe("@phase26 @divider WS-05: divider resize", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("dragging the divider resizes both panes live — WS-05/D-13", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);
    const { left, right } = await setupSplit(page, jasper.baseURL);

    const leftBoxBefore = await left.boundingBox();
    const rightBoxBefore = await right.boundingBox();
    if (!leftBoxBefore || !rightBoxBefore) throw new Error("pane bounding box missing");

    const handle = page.locator(SELECTORS.paneDividerHandle);
    const handleBoxBefore = await handle.boundingBox();
    if (!handleBoxBefore) throw new Error("divider handle bounding box missing");

    await dragDividerTo(page, handleBoxBefore.x + handleBoxBefore.width / 2 + 120);

    // Live reflow: the left pane widened and the right pane narrowed.
    await expect
      .poll(async () => {
        const b = await left.boundingBox();
        return b?.width ?? 0;
      })
      .toBeGreaterThan(leftBoxBefore.width + 60);

    const leftBoxAfter = await left.boundingBox();
    const rightBoxAfter = await right.boundingBox();
    if (!leftBoxAfter || !rightBoxAfter) throw new Error("pane bounding box missing after drag");
    expect(leftBoxAfter.width).toBeGreaterThan(leftBoxBefore.width);
    expect(rightBoxAfter.width).toBeLessThan(rightBoxBefore.width);

    // Screenshot of a resized layout for the phase-end human UAT.
    fs.mkdirSync(SHOTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(SHOTS_DIR, "phase26-divider.png") });
  });
});

// ─── WS-05 / D-14 — 160px clamp ──────────────────────────────────────────────

test.describe("@phase26 @divider WS-05: divider clamp", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("dragging past the left pane's edge stops at the 160px minimum — WS-05/D-14", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);
    const { left } = await setupSplit(page, jasper.baseURL);

    // Drag far past the left pane's edge — the divider must stop at the
    // clamp rather than crushing the pane down to (or below) the drop point.
    await dragDividerTo(page, 5);

    await expect
      .poll(async () => {
        const b = await left.boundingBox();
        return b?.width ?? 0;
      })
      .toBeGreaterThanOrEqual(150); // ~160px min, small tolerance
  });
});

// ─── WS-05 / D-13 — persistence across reload ────────────────────────────────

test.describe("@phase26 @divider WS-05: divider resize persistence", () => {
  let jasper: JasperHandle;
  let appHome: string;
  test.beforeAll(async () => {
    ({ jasper, appHome } = await spawnIsolated());
  });
  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (appHome) fs.rmSync(appHome, { recursive: true, force: true });
  });

  test("the resized ratio survives a full page reload — WS-05/D-13", async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await waitForConnected(page, jasper.baseURL);
    const { left } = await setupSplit(page, jasper.baseURL);

    const handle = page.locator(SELECTORS.paneDividerHandle);
    const handleBoxBefore = await handle.boundingBox();
    if (!handleBoxBefore) throw new Error("divider handle bounding box missing");
    await dragDividerTo(page, handleBoxBefore.x + handleBoxBefore.width / 2 + 150);

    // Persistence is debounced (~250ms) — poll localStorage until the tree is
    // a SPLIT node whose ratio has moved meaningfully away from the default
    // 0.5 before reloading. (A plain "!== 0.5" check on a leaf-shaped tree
    // would false-pass immediately — a leaf has no `ratio` field at all.)
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const key = Object.keys(localStorage).find((k) => k.startsWith("jasper.layout."));
            if (key === undefined) return null;
            const raw = localStorage.getItem(key) ?? "";
            try {
              const parsed = JSON.parse(raw) as { tree?: { t?: string; ratio?: number } };
              if (parsed.tree?.t !== "split" || typeof parsed.tree.ratio !== "number") return null;
              return parsed.tree.ratio;
            } catch {
              return null;
            }
          }),
        { timeout: 5_000 },
      )
      .not.toBeNull();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const key = Object.keys(localStorage).find((k) => k.startsWith("jasper.layout."));
            if (key === undefined) return 0;
            const raw = localStorage.getItem(key) ?? "";
            try {
              const parsed = JSON.parse(raw) as { tree?: { t?: string; ratio?: number } };
              if (parsed.tree?.t !== "split" || typeof parsed.tree.ratio !== "number") return 0;
              return Math.abs(parsed.tree.ratio - 0.5);
            } catch {
              return 0;
            }
          }),
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0.01);

    const leftBoxBeforeReload = await left.boundingBox();
    if (!leftBoxBeforeReload) throw new Error("left pane bounding box missing before reload");

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    await expect(leafPanes(page)).toHaveCount(2, { timeout: 10_000 });

    const restoredLeft = leafPanes(page).nth(0);
    await expect
      .poll(
        async () => {
          const b = await restoredLeft.boundingBox();
          if (!b) return Number.POSITIVE_INFINITY;
          return Math.abs(b.width - leftBoxBeforeReload.width);
        },
        { timeout: 10_000 },
      )
      .toBeLessThan(20);
  });
});
