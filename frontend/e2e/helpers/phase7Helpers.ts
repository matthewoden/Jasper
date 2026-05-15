/**
 * phase7Helpers.ts — Phase 7 UAT helper utilities.
 *
 * Reusable helpers for Phase 7 Playwright E2E scenarios:
 * - pressShortcut: translates symbolic shortcuts to keyboard combos
 * - openCommandMenu: opens Cmd+O (notes) or Cmd+P (commands) modal
 * - apiCreateNote: creates a note via POST /api/v1/notes + PUT /api/v1/notes/{id}
 * - waitForConnected: waits for the WebSocket connection-status dot to show "connected"
 *
 * Plan 07-21 additions (ADD-only; no existing helpers modified):
 * - openCommandMenuAndType: opens palette in specified mode and types a query
 * - expectPaletteVisibleWithNCommands: asserts all 9 commands visible in palette (S13a)
 * - seedDailyNoteWithTags: writes a daily note file directly to disk (S12)
 * - dispatchSyntheticDragOver: fires a synthetic DragEvent on an element (S16)
 * - dispatchSyntheticDragLeave: fires a synthetic dragleave DragEvent (S16)
 * - seedNoteWithMtime: seeds a note and sets its mtime on disk (S15)
 * - activateTagFilterChip: clicks a tag row in the right rail to set the active filter (S2)
 *
 * Platform: macOS uses Meta modifier; WSL/Linux uses Control.
 * The E2E suite runs on macOS (CI + dev); WSL is a secondary target.
 */
import type { Page } from "@playwright/test";

// ─────────────────────────────────────────────────────────────────────────────
// Shortcut helpers
// ─────────────────────────────────────────────────────────────────────────────

type Shortcut =
  | "CmdO"        // Cmd+O — quick switcher
  | "CmdP"        // Cmd+P — command palette
  | "CmdShiftD"   // Cmd+Shift+D — today's daily note
  | "CmdSlash"    // Cmd+/ — keyboard shortcuts cheat-sheet
  | "CmdN"        // Cmd+N — new note
  | "CmdS"        // Cmd+S — save
  | "CmdF"        // Cmd+F — native browser find (NOT CM6 panel after Plan 07-27)
  | "CmdB"        // Cmd+B — bold
  | "CmdI"        // Cmd+I — italic
  | "CmdU"        // Cmd+U — underline (Plan 07-27 / UAT-2 N7)
  | "EscKey";     // Escape

const MOD = process.platform === "darwin" ? "Meta" : "Control";

const SHORTCUT_MAP: Record<Shortcut, string> = {
  CmdO: `${MOD}+o`,
  CmdP: `${MOD}+p`,
  CmdShiftD: `${MOD}+Shift+d`,
  CmdSlash: `${MOD}+/`,
  CmdN: `${MOD}+n`,
  CmdS: `${MOD}+s`,
  CmdF: `${MOD}+f`,
  CmdB: `${MOD}+b`,
  CmdI: `${MOD}+i`,
  CmdU: `Control+u`,  // Plan 07-27: CM6 maps Mod-u → ctrlKey in headless Win32
  EscKey: "Escape",
};

/**
 * Press a named keyboard shortcut.
 *
 * @param page - Playwright Page
 * @param key  - Symbolic shortcut name (e.g., "CmdO", "CmdShiftD")
 */
export async function pressShortcut(page: Page, key: Shortcut): Promise<void> {
  const combo = SHORTCUT_MAP[key];
  await page.keyboard.press(combo);
}

// ─────────────────────────────────────────────────────────────────────────────
// CommandMenu helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the CommandMenu modal in the specified mode.
 *
 * @param page - Playwright Page
 * @param mode - "notes" (Cmd+O quick switcher) or "commands" (Cmd+P palette)
 */
export async function openCommandMenu(
  page: Page,
  mode: "notes" | "commands"
): Promise<void> {
  const shortcut: Shortcut = mode === "notes" ? "CmdO" : "CmdP";
  await pressShortcut(page, shortcut);
  const ariaLabel = mode === "notes" ? "Quick switcher" : "Command palette";
  // Wait for the dialog to appear
  await page.getByRole("dialog", { name: ariaLabel }).waitFor({ state: "visible", timeout: 5_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// API helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a note via the Jasper REST API.
 *
 * Mirrors the `apiCreateNote` helper in phase6.6-uat.spec.ts but accepts
 * the baseURL explicitly so it can be used without a shared jasper handle.
 *
 * @param page       - Playwright Page (for page.request)
 * @param baseURL    - Jasper server base URL (e.g., "http://127.0.0.1:12345")
 * @param filename   - Note filename without leading "notes/" (e.g., "alpha.md")
 * @param parentPath - Parent folder path relative to notes/ root (e.g., "daily"); default ""
 * @param content    - Markdown content to write into the note
 * @returns The note UUID
 */
export async function apiCreateNote(
  page: Page,
  baseURL: string,
  filename: string,
  parentPath: string,
  content: string
): Promise<string> {
  const title = filename.replace(/\.md$/, "");

  const createResp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path: parentPath, title },
  });
  if (createResp.status() !== 201) {
    const body = await createResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: POST returned ${String(createResp.status())} for ${filename}: ${body}`
    );
  }
  const created = (await createResp.json()) as { id: string };
  const id = created.id;

  // Write content via PUT
  const updateResp = await page.request.put(`${baseURL}/api/v1/notes/${id}`, {
    data: { content },
  });
  if (updateResp.status() !== 200) {
    const body = await updateResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: PUT returned ${String(updateResp.status())} for ${filename}: ${body}`
    );
  }

  return id;
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for the WebSocket connection-status dot to show "connected".
 * This is the canonical "app is ready" signal in Phase 4+.
 *
 * @param page      - Playwright Page
 * @param timeoutMs - Max wait in ms (default 10s)
 */
export async function waitForConnected(page: Page, timeoutMs = 10_000): Promise<void> {
  const { expect } = await import("@playwright/test");
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: timeoutMs }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Plan 07-21 helpers — ADD-ONLY (other E2E suites depend on all helpers above)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * openCommandMenuAndType — opens the CommandMenu in the specified mode,
 * waits for it to appear, then fills the query input. (S1, S2, S13, S15)
 *
 * @param page  - Playwright Page
 * @param mode  - "switch" (Cmd+O, notes mode) | "command" (Cmd+P, commands mode)
 * @param query - Text to type into the input (may be empty to just open)
 */
export async function openCommandMenuAndType(
  page: Page,
  mode: "switch" | "command",
  query: string,
): Promise<void> {
  await page.keyboard.press(mode === "switch" ? "Meta+o" : "Meta+p");
  const ariaLabel = mode === "switch" ? "Quick switcher" : "Command palette";
  const dialog = page.getByRole("dialog", { name: ariaLabel });
  await dialog.waitFor({ state: "visible", timeout: 5_000 });
  if (query) {
    const input = dialog.getByRole("textbox");
    await input.fill(query);
  }
}

/**
 * expectPaletteVisibleWithNCommands — asserts all 8 expected commands are
 * visible in the Command palette dialog (S13a / UAT #2).
 *
 * The 8 palette-visible commands (inPalette: true in shortcutsRegistry.ts):
 *   New note, Save, Today, Switch / search notes,
 *   Toggle theme, Refresh index, Reset and rebuild…, Show keyboard shortcuts.
 *
 * Note: "Find in note" was removed in Plan 07-27 — browser native Cmd+F fires.
 *
 * @param page - Playwright Page
 * @param n    - Expected command count (used for diagnostic reporting)
 */
export async function expectPaletteVisibleWithNCommands(
  page: Page,
  n: number,
): Promise<void> {
  const { expect } = await import("@playwright/test");
  const dialog = page.getByRole("dialog", { name: "Command palette" });
  await expect(dialog).toBeVisible({ timeout: 5_000 });

  // Assert the 8 palette-visible commands by their label text (Plan 07-27: Find removed).
  // This locks the UI-SPEC §Command Registry table strings.
  const expectedLabels = [
    "New note",
    "Save",
    // "Find in note" removed in Plan 07-27
    "Today",
    "Switch / search notes",
    "Toggle theme",
    "Refresh index",
    "Reset and rebuild…",
    "Show keyboard shortcuts",
  ];
  // n must match the list length for the assertion to be meaningful.
  if (n !== expectedLabels.length) {
    throw new Error(
      `expectPaletteVisibleWithNCommands: n=${n} does not match expectedLabels.length=${expectedLabels.length}`,
    );
  }
  for (const label of expectedLabels) {
    // The virtualized list renders all items for 8 commands at 36px each (288px)
    // which fits in the 50vh max-height. Using page-level getByText to avoid
    // stale scoping on the dialog locator while virtualizer renders.
    await expect(page.getByText(label, { exact: false }).first()).toBeVisible({
      timeout: 5_000,
    });
  }
}

/**
 * seedDailyNoteWithTags — writes a daily note with YAML frontmatter tags
 * directly to disk under dataDir/notes/daily/. Used by S12 (registry scenario).
 *
 * @param dataDir - jasper.dataDir from JasperHandle
 * @param date    - ISO date string (YYYY-MM-DD) for the filename
 * @param tags    - Array of tag strings to embed in frontmatter
 */
export async function seedDailyNoteWithTags(
  dataDir: string,
  date: string,
  tags: string[],
): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const dailyDir = path.join(dataDir, "notes", "daily");
  await mkdir(dailyDir, { recursive: true });
  const tagsYaml = tags.length > 0
    ? `---\ntags: [${tags.join(", ")}]\n---\n\n`
    : "";
  const content = `${tagsYaml}# ${date}\n\nDaily note for ${date}.\n`;
  await writeFile(path.join(dailyDir, `${date}.md`), content, "utf-8");
}

/**
 * dispatchSyntheticDragOver — dispatches a synthetic DragEvent("dragover")
 * on the element matching selector. Used by S16 (drop indicator / UAT #12).
 *
 * Headless Playwright cannot perform real OS file drags from the filesystem;
 * synthetic events are the standard pattern for testing DOM-level DnD handlers.
 *
 * @param page     - Playwright Page
 * @param selector - CSS selector for the target element (e.g. ".cm-editor")
 * @param x        - clientX for the synthetic event
 * @param y        - clientY for the synthetic event
 */
export async function dispatchSyntheticDragOver(
  page: Page,
  selector: string,
  x: number,
  y: number,
): Promise<void> {
  await page.evaluate(
    ({ sel, cx, cy }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`dispatchSyntheticDragOver: element not found: ${sel}`);
      // We must use a DataTransfer whose .types array includes "Files" for
      // the dropIndicatorPlugin's guard check to pass. DataTransfer.types is
      // readonly in real events, but the browser allows it via dt.items.add().
      const dt = new DataTransfer();
      // Create a tiny placeholder file so types includes "Files".
      const file = new File([""], "placeholder.txt", { type: "text/plain" });
      dt.items.add(file);
      const ev = new DragEvent("dragover", {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: cy,
        dataTransfer: dt,
      });
      el.dispatchEvent(ev);
    },
    { sel: selector, cx: x, cy: y },
  );
}

/**
 * dispatchSyntheticDragLeave — dispatches a synthetic DragEvent("dragleave")
 * on the element matching selector, clearing the drop indicator. (S16)
 *
 * @param page     - Playwright Page
 * @param selector - CSS selector for the target element (e.g. ".cm-editor")
 */
export async function dispatchSyntheticDragLeave(
  page: Page,
  selector: string,
): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`dispatchSyntheticDragLeave: element not found: ${sel}`);
    const ev = new DragEvent("dragleave", { bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
  }, selector);
}

/**
 * seedNoteWithMtime — creates a note via the API and then sets the file's
 * mtime on disk to a specific Unix epoch time. Used by S15 (updated_at
 * fallback sort / UAT #10) to create notes with deterministic sort order.
 *
 * NOTE: Setting mtime changes the filesystem mtime but the SQLite index
 * stores updated_at from file stat. After seeding, trigger a reindex so the
 * modified_at value is reflected in the in-memory tree. (S15 handles this.)
 *
 * @param page       - Playwright Page (for page.request)
 * @param baseURL    - Jasper server base URL
 * @param dataDir    - jasper.dataDir from JasperHandle
 * @param filename   - Note filename (e.g. "oldest.md")
 * @param content    - Markdown content
 * @param mtimeSec   - Unix epoch seconds for the file mtime
 * @returns The note UUID
 */
export async function seedNoteWithMtime(
  page: Page,
  baseURL: string,
  dataDir: string,
  filename: string,
  content: string,
  mtimeSec: number,
): Promise<string> {
  const id = await apiCreateNote(page, baseURL, filename, "", content);
  // Set the file's mtime on disk.
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const filePath = path.join(dataDir, "notes", filename);
  const mtime = new Date(mtimeSec * 1000);
  await fs.utimes(filePath, mtime, mtime);
  return id;
}

/**
 * activateTagFilterChip — clicks a tag row in the right-rail Tags panel to
 * set the active tag filter, then waits for the ActiveTagFilterChip to render.
 * Used by S2 (palette search + tag AND combination / UAT #11).
 *
 * Locator chain (audited from RightRailTagsPanel.tsx + ActiveTagFilterChip.tsx):
 *   1. Each tag row exposes data-testid="tag-row-${tag.name}" (line 413).
 *   2. If the panel is collapsed (aria-label matches "Tags panel, collapsed.*"),
 *      click the header button to expand it first.
 *   3. After click, ActiveTagFilterChip renders with aria-label
 *      "Active filter: #${tagName}" (ActiveTagFilterChip.tsx:76) — wait for it.
 *
 * @param page    - Playwright Page
 * @param tagName - Tag name without leading "#"
 */
export async function activateTagFilterChip(
  page: Page,
  tagName: string,
): Promise<void> {
  const { expect } = await import("@playwright/test");

  // Step 0: ensure the right rail is expanded (backlinksRailExpanded = true).
  // When collapsed, RightRail returns null and the Tags panel is not in the DOM.
  // TopBar renders a "Show panels" button when collapsed (aria-label="Show panels").
  const showPanelsBtn = page.getByRole("button", { name: "Show panels" });
  if ((await showPanelsBtn.count()) > 0) {
    await showPanelsBtn.click();
    // Wait for the rail to appear (tag row testid becomes visible).
    await expect(showPanelsBtn).toHaveCount(0, { timeout: 3_000 });
  }

  // Step 1: ensure the Tags panel is expanded within the right rail.
  // The panel header button has aria-label matching "Tags panel, collapsed.*".
  const collapsedHeader = page.getByRole("button", {
    name: /^Tags panel, collapsed/,
  });
  if ((await collapsedHeader.count()) > 0) {
    await collapsedHeader.click();
    // Wait for the panel to expand (the collapsed header disappears).
    await expect(collapsedHeader).toHaveCount(0, { timeout: 3_000 });
  }

  // Step 2: click the tag row.
  const row = page.getByTestId(`tag-row-${tagName}`);
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await row.click();

  // Step 3: wait for ActiveTagFilterChip to render as the success signal.
  // role="status" + aria-label="Active filter: #${tagName}" (ActiveTagFilterChip.tsx:76).
  await expect(
    page.getByRole("status", { name: `Active filter: #${tagName}` }),
  ).toBeVisible({ timeout: 3_000 });
}
