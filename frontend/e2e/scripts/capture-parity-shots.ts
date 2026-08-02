#!/usr/bin/env node
/**
 * Ad hoc capture script, never a CI gate: walks every surface in the re-verify
 * checklist and screenshots each to `.parity-shots/` for the owner's side-by-side
 * review. These images are for human review only — this is not a pixel-diff
 * pipeline.
 *
 * A stale bin/jasper silently screenshots the pre-fix UI. Always `make build`
 * immediately before.
 *
 * Usage: cd frontend && make build && npx tsx e2e/scripts/capture-parity-shots.ts
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
const VIEWPORT = { width: 1440, height: 900 };
const MOD = process.platform === "darwin" ? "Meta" : "Control";

function log(msg: string): void {
  console.log(`[capture-parity-shots] ${msg}`);
}

async function createNote(baseURL: string, title: string): Promise<string> {
  const resp = await fetch(`${baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: "", title }),
  });
  if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
  return ((await resp.json()) as { id: string }).id;
}

async function setNoteContent(baseURL: string, id: string, content: string): Promise<void> {
  const resp = await fetch(`${baseURL}/api/v1/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) throw new Error(`set content ${id}: ${resp.status}`);
}

function noteRow(page: Page, id: string) {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row + editor to mount. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await row.waitFor({ state: "visible", timeout: 10_000 });
  await row.click();
  // Tabs keep prior editors mounted-but-hidden (tab model), so
  // `.cm-content` can resolve to >1 element — scope to the one actually
  // visible (the active tab's pane).
  await page.locator(".cm-content:visible").waitFor({ state: "visible", timeout: 10_000 });
}

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await page
    .getByTestId("connection-status-dot")
    .waitFor({ state: "visible", timeout: 10_000 });
  // expect.poll is unavailable outside a test runner — poll manually.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const status = await page
      .getByTestId("connection-status-dot")
      .getAttribute("data-status");
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

async function shootLocator(page: Page, selector: string, name: string): Promise<void> {
  const dest = path.join(SHOTS_DIR, name);
  // Tabs keep prior editors mounted-but-hidden (tab model); scope to
  // the visible instance so a stale/hidden duplicate never wins the race.
  const locator = page.locator(`${selector}:visible`).first();
  await locator.waitFor({ state: "visible", timeout: 10_000 });
  await locator.screenshot({ path: dest });
  log(`captured ${name}`);
}

async function main(): Promise<void> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  log("spawning rebuilt jasper binary...");
  const jasper: JasperHandle = await spawnJasper();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT });

  try {
    await waitForConnected(page, jasper.baseURL);

    // ── Seed one note per center-column surface (mirrors the fixture style
    //    already used in phase21-uat.spec.ts: a small dedicated note per
    //    surface keeps each screenshot legible and avoids scroll ambiguity).
    const proseId = await createNote(jasper.baseURL, "parity-prose-note");
    await setNoteContent(
      jasper.baseURL,
      proseId,
      "# parity-prose-note\n\n" +
        "This is a paragraph of proportional prose text used to visually confirm the " +
        "P0 monospace-prose fix has landed correctly across the reading surface. The " +
        "quick brown fox jumps over the lazy dog.\n\n" +
        "A second paragraph continues the reading column with more body copy so the " +
        "screenshot shows sustained proportional rhythm, not just a single line.\n",
    );

    const headingsId = await createNote(jasper.baseURL, "parity-headings-note");
    await setNoteContent(
      jasper.baseURL,
      headingsId,
      "# parity-headings-note\n\n" +
        "# Second H1 Heading\n\n" +
        "## H2 Heading\n\n" +
        "### H3 Heading\n\n" +
        "#### H4 Heading\n\n" +
        "##### H5 Heading\n\n" +
        "###### H6 Heading\n",
    );

    const calloutsId = await createNote(jasper.baseURL, "parity-callouts-note");
    await setNoteContent(
      jasper.baseURL,
      calloutsId,
      "# parity-callouts-note\n\n" +
        "> [!tip] Tip title\n> body\n\n" +
        "> [!note] Note title\n\n" +
        "> [!warning] Warning title\n\n" +
        "> [!danger] Danger title\n",
    );

    const tableId = await createNote(jasper.baseURL, "parity-table-note");
    await setNoteContent(
      jasper.baseURL,
      tableId,
      "# parity-table-note\n\n" +
        "| Header 1 | Header 2 | Header 3 |\n" +
        "| --- | --- | --- |\n" +
        "| Row 1 Col 1 | Row 1 Col 2 | Row 1 Col 3 |\n" +
        "| Row 2 Col 1 | Row 2 Col 2 | Row 2 Col 3 |\n",
    );

    const tokensId = await createNote(jasper.baseURL, "parity-tags-links-note");
    await setNoteContent(
      jasper.baseURL,
      tokensId,
      "# parity-tags-links-note\n\n" +
        "A paragraph with a #parity-tag and a [[wiki-link-target]] plus some " +
        "==highlighted text== for token review.\n",
    );

    // Reload so the tree reflects all five newly-seeded notes before we start
    // clicking rows (the tree is fetched once on connect).
    await page.reload();
    await waitForConnected(page, jasper.baseURL);

    // ── 1. Editor prose column (also frames title/ribbon/sidebar/tabs — the
    //       primary "does the whole app read proportional now" shot). ──────
    await openNoteFromTree(page, proseId);
    await page
      .locator(".cm-line:visible")
      .filter({ hasText: "quick brown fox" })
      .waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "01-prose-column.png");

    // ── 2. Note title (cropped). ──────────────────────────────────────────
    await shootLocator(page, '[data-testid="editor-title-element"]', "02-note-title.png");

    // ── 3. Headings H1-H6. ─────────────────────────────────────────────────
    await openNoteFromTree(page, headingsId);
    await page.locator(".cm-heading-6:visible").first().waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "03-headings.png");

    // ── 4. Callouts. ───────────────────────────────────────────────────────
    await openNoteFromTree(page, calloutsId);
    await page.locator(".cm-callout-danger:visible").first().waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "04-callouts.png");

    // ── 5. Tables (cursor starts outside the table -> widget renders). ─────
    await openNoteFromTree(page, tableId);
    await page.locator(".cm-table:visible").first().waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "05-tables.png");

    // ── 6. Tags / wiki-links / highlight. ───────────────────────────────────
    await openNoteFromTree(page, tokensId);
    await page.locator(".cm-inline-tag:visible").first().waitFor({ state: "visible", timeout: 5_000 });
    await page.locator(".cm-highlight:visible").first().waitFor({ state: "visible", timeout: 5_000 });
    await shoot(page, "06-tags-wikilinks-highlight.png");

    // ── 7. Left file-tree sidebar. ──────────────────────────────────────────
    await shootLocator(page, 'nav[aria-label="Notes navigation"]', "07-left-sidebar.png");

    // ── 8. Right rail (Outline / Linked mentions / Tags). ───────────────────
    await shootLocator(
      page,
      'aside:has([aria-label="Resize backlinks panel"])',
      "08-right-rail.png",
    );

    // ── 9. Activity ribbon. ─────────────────────────────────────────────────
    await shootLocator(page, 'nav[aria-label="Activity ribbon"]', "09-activity-ribbon.png");

    // ── 10. Tab bar. ─────────────────────────────────────────────────────────
    await shootLocator(page, '[data-testid="tab-strip"]', "10-tab-bar.png");

    // ── 11. Breadcrumb + word count (same nav element). ─────────────────────
    await shootLocator(page, '[data-testid="note-breadcrumb"]', "11-breadcrumb-word-count.png");

    // ── 12. Command palette (unified Cmd/Ctrl+K; mode="all" has
    //         aria-label "Search everything" — Cmd+P/"Command palette" is
    //         the commands-only mode). ────────────────────────────────────
    await page.keyboard.press(`${MOD}+k`);
    await page.getByRole("dialog", { name: "Search everything" }).waitFor({
      state: "visible",
      timeout: 5_000,
    });
    await shoot(page, "12-command-palette.png");
    await page.keyboard.press("Escape");
    await page
      .getByRole("dialog", { name: "Search everything" })
      .waitFor({ state: "hidden", timeout: 5_000 });

    // ── 13. Zen mode. ────────────────────────────────────────────────────────
    await page.keyboard.press(`${MOD}+.`);
    await page.locator('[data-zen="true"]').waitFor({ state: "attached", timeout: 5_000 });
    await shoot(page, "13-zen-mode.png");
    await page.keyboard.press(`${MOD}+.`);

    log(`done — ${13} screenshots written to ${SHOTS_DIR}`);
  } finally {
    await browser.close();
    await jasper.kill();
  }
}

main().catch((err) => {
  console.error("[capture-parity-shots] FAILED:", err);
  process.exitCode = 1;
});
