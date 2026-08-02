#!/usr/bin/env node
/**
 * capture-rail-collapsed-shots.ts — 260721-cjt Task 3 (owner UI review).
 *
 * Ad hoc (non-CI-gating) Playwright capture script, adapted from
 * capture-parity-shots.ts (PARITY-03): reuses spawnJasper() against
 * a freshly `make build`-rebuilt binary, captures four states of the right
 * rail's flush-collapse + tab-bar reopen toggle contract for the owner's
 * side-by-side review, and writes them to `.parity-shots/`.
 *
 * This does NOT build a pixel-diff/visual-regression pipeline — these images
 * are for human review only, never an automated pass/fail gate.
 *
 * Pitfall: a stale bin/jasper silently screenshots the
 * pre-fix UI. Always run `make build` immediately before this script.
 *
 * Usage: cd frontend && make -C .. build && npx tsx e2e/scripts/capture-rail-collapsed-shots.ts
 */
import { chromium, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnJasper, type JasperHandle } from "../helpers/binary";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const SHOTS_DIR = path.join(repoRoot, ".parity-shots");
const VIEWPORT = { width: 1512, height: 944 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";

function log(msg: string): void {
  console.log(`[capture-rail-collapsed-shots] ${msg}`);
}

async function createNote(baseURL: string, title: string, content: string): Promise<string> {
  const resp = await fetch(`${baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: "", title }),
  });
  if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
  const { id } = (await resp.json()) as { id: string };
  const putResp = await fetch(`${baseURL}/api/v1/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!putResp.ok) throw new Error(`set content ${id}: ${putResp.status}`);
  return id;
}

function noteRow(page: Page, id: string) {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row + editor to mount. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.click();
  await page.locator(".cm-content:visible").first().waitFor({ state: "visible", timeout: 10_000 });
}

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await page.getByTestId("connection-status-dot").waitFor({ state: "visible", timeout: 10_000 });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await page.getByTestId("connection-status-dot").getAttribute("data-status");
    if (status === "connected") return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("connection-status-dot never reached data-status=connected");
}

async function shoot(page: Page, name: string): Promise<void> {
  const dest = path.join(SHOTS_DIR, name);
  await page.screenshot({ path: dest, fullPage: false });
  log(`captured ${name}`);
}

/** Command palette "Split right" — clones the active leaf's active tab into a new sibling leaf. */
async function splitRight(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+p`);
  const input = page.getByPlaceholder("Type a command…");
  await input.waitFor({ state: "visible", timeout: 5_000 });
  await input.fill("Split right");
  const row = page.locator('[data-row-kind="cmd"]').filter({ hasText: "Split right" }).first();
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await row.click();
  await page.locator('[data-testid="pane-divider"]').first().waitFor({ state: "visible", timeout: 5_000 });
}

async function main(): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  log("spawning rebuilt jasper binary...");
  const jasper: JasperHandle = await spawnJasper();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  try {
    await waitForConnected(page, jasper.baseURL);

    const noteId = await createNote(
      jasper.baseURL,
      "rail-shots-note",
      "# rail-shots-note\n\nBody text for the 260721-cjt owner-review screenshots.\n",
    );
    await page.reload();
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    // ── 1. Rail expanded (baseline, unchanged from 30-13). ──────────────────
    const tabRow = page.getByTestId("right-rail-tab-row");
    await tabRow.waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "rail-expanded.png");

    // ── 2. Rail collapsed: editor flush to the right edge, tab-bar reopen
    //       toggle visible on the rightmost (only) pane. ─────────────────────
    const collapseBtn = tabRow.getByRole("button", { name: "Collapse panels" });
    await collapseBtn.waitFor({ state: "visible", timeout: 5_000 });
    await collapseBtn.click();
    await tabRow.waitFor({ state: "hidden", timeout: 5_000 });
    const rightCluster = page.getByTestId("tab-strip-right-cluster");
    await rightCluster.waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "rail-collapsed-flush.png");

    // ── 3. Reopen via the tab-bar toggle — rail expands again. ──────────────
    await rightCluster.getByRole("button", { name: "Show panels" }).click();
    await tabRow.waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "rail-reopened.png");

    // ── 4. Two-pane row split, rail collapsed: exactly ONE tab-bar toggle,
    //       on the rightmost pane only. ──────────────────────────────────────
    await splitRight(page);
    await collapseBtn.click();
    await tabRow.waitFor({ state: "hidden", timeout: 5_000 });
    await page.getByTestId("tab-strip-right-cluster").waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "rail-split-collapsed.png");

    log(`done — 4 screenshots written to ${SHOTS_DIR}`);
  } finally {
    await browser.close();
    await jasper.kill();
  }
}

main().catch((err) => {
  console.error("[capture-rail-collapsed-shots] FAILED:", err);
  process.exitCode = 1;
});
