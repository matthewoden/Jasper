/**
 * phase7Helpers.ts — Phase 7 UAT helper utilities.
 *
 * Reusable helpers for Phase 7 Playwright E2E scenarios:
 * - pressShortcut: translates symbolic shortcuts to keyboard combos
 * - openCommandMenu: opens Cmd+O (notes) or Cmd+P (commands) modal
 * - apiCreateNote: creates a note via POST /api/v1/notes + PUT /api/v1/notes/{id}
 * - waitForConnected: waits for the WebSocket connection-status dot to show "connected"
 * - openCommandMenuAndType: opens palette in specified mode and types a query
 * - expectPaletteVisibleWithNCommands: asserts all commands visible in palette
 * - seedDailyNoteWithTags: writes a daily note file directly to disk
 * - dispatchSyntheticDragOver: fires a synthetic DragEvent on an element
 * - dispatchSyntheticDragLeave: fires a synthetic dragleave DragEvent
 * - seedNoteWithMtime: seeds a note and sets its mtime on disk
 * - activateTagFilterChip: clicks a tag row in the right rail to set the active filter
 *
 * Platform: macOS uses Meta modifier; WSL/Linux uses Control.
 * The E2E suite runs on macOS (CI + dev); WSL is a secondary target.
 */
import type { Page } from "@playwright/test";


type Shortcut =
  | "CmdO"
  | "CmdP"
  | "CmdShiftD"
  | "CmdSlash"
  | "CmdN"
  | "CmdS"
  | "CmdF"
  | "CmdB"
  | "CmdI"
  // CmdU removed — underline binding reverted.
  | "EscKey";

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
  await page.getByRole("dialog", { name: ariaLabel }).waitFor({ state: "visible", timeout: 5_000 });
}


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


/**
 * Wait for the WebSocket connection-status dot to show "connected".
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


/**
 * openCommandMenuAndType — opens the CommandMenu in the specified mode,
 * waits for it to appear, then fills the query input.
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
    // Quick switcher (mode="notes") input has role="combobox" (aria-expanded
    // + aria-controls listbox wiring, added after this helper was written);
    // the Command palette (mode="commands") input remains a plain textbox.
    const input = mode === "switch" ? dialog.getByRole("combobox") : dialog.getByRole("textbox");
    await input.fill(query);
  }
}

/**
 * expectPaletteVisibleWithNCommands — asserts all expected commands are
 * visible in the Command palette dialog.
 *
 * The 17 palette-visible commands (inPalette: true in shortcutsRegistry.ts,
 * locked by shortcutsRegistry.test.ts's "registry has all 17 locked Cmd+P
 * palette entries" test — updated here as more commands were added across
 * Phase 22/25/27/28 and "Switch / search notes" was relabeled to
 * "Quick switcher (notes)" in Phase 28 Plan 03):
 *   New note, Save, Today, Quick switcher (notes), Toggle theme,
 *   Refresh index, Reset and rebuild…, Show keyboard shortcuts,
 *   Show current note in file manager, Switch vault…, Toggle Zen Mode,
 *   Split right, Split down, Focus next pane, Focus previous pane,
 *   Toggle left sidebar, Bookmark current note.
 *
 * "Find in note" is absent — browser native Cmd+F fires instead.
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

  const expectedLabels = [
    "New note",
    "Save",
    "Today",
    "Quick switcher (notes)",
    "Toggle theme",
    "Refresh index",
    "Reset and rebuild…",
    "Show keyboard shortcuts",
    "Show current note in file manager",
    "Switch vault…",
    "Toggle Zen Mode",
    "Split right",
    "Split down",
    "Focus next pane",
    "Focus previous pane",
    "Toggle left sidebar",
    "Bookmark current note",
  ];
  if (n !== expectedLabels.length) {
    throw new Error(
      `expectPaletteVisibleWithNCommands: n=${n} does not match expectedLabels.length=${expectedLabels.length}`,
    );
  }

  // Cold-open (this test's original intent, Plan 07-27): the very first
  // command must render immediately — proves the palette isn't stuck on an
  // empty/null-tree state before the first fetch resolves.
  await expect(
    page.getByText(expectedLabels[0], { exact: true }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // The palette list is virtualized (@tanstack/react-virtual, 36px rows,
  // 50vh max-height) — since the registry grew from 8 to 17 entries
  // (Phase 22/25/27/28), the tail entries no longer render in the DOM
  // without scrolling. ArrowDown moves selectedIdx, which the component's
  // own effect feeds into virtualizer.scrollToIndex — drive that real user
  // interaction and record every label as it becomes visible, bounded by
  // the list length (no fixed sleeps).
  const seen = new Set<string>();
  for (let i = 0; i < expectedLabels.length; i++) {
    for (const label of expectedLabels) {
      if (seen.has(label)) continue;
      if (await page.getByText(label, { exact: true }).first().isVisible().catch(() => false)) {
        seen.add(label);
      }
    }
    if (seen.size === expectedLabels.length) break;
    await page.keyboard.press("ArrowDown");
  }
  for (const label of expectedLabels) {
    expect(
      seen.has(label),
      `expected command "${label}" to become visible while scrolling the palette`,
    ).toBe(true);
  }
}

/**
 * seedDailyNoteWithTags — writes a daily note with YAML frontmatter tags
 * directly to disk under dataDir/notes/daily/.
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
 * on the element matching selector.
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
      const dt = new DataTransfer();
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
 * on the element matching selector, clearing the drop indicator.
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
 * mtime on disk to a specific Unix epoch time, for deterministic sort order.
 *
 * NOTE: Setting mtime changes the filesystem mtime but the SQLite index
 * stores updated_at from file stat. After seeding, trigger a reindex so the
 * modified_at value is reflected in the in-memory tree.
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
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const filePath = path.join(dataDir, "notes", filename);
  const mtime = new Date(mtimeSec * 1000);
  await fs.utimes(filePath, mtime, mtime);
  return id;
}

/**
 * activateTagFilterChip — clicks a tag row in the right-rail Tags tab to
 * set the active tag filter, then waits for the ActiveTagFilterChip to render.
 *
 * Locator chain (audited from RightRail.tsx / RightRailTabRow.tsx / Right-
 * RailTagsPanel.tsx + ActiveTagFilterChip.tsx, current as of the Phase 30
 * rail rewrite — the rail is a one-panel-at-a-time icon-tab row, not the
 * old Phase 20 stacked/collapsible-sections layout):
 *   1. If the rail is collapsed, the rightmost pane's tab-strip carries a
 *      "Show panels" reopen button — click it first.
 *   2. Click the "Tags" tab in the right-rail-tab-row testid to mount
 *      RightRailTagsPanel (there is no more per-section collapse header).
 *   3. Each tag row exposes data-testid="tag-row-${tag.name}".
 *   4. After click, ActiveTagFilterChip renders with aria-label
 *      "Active filter: #${tagName}" — wait for it.
 *
 * @param page    - Playwright Page
 * @param tagName - Tag name without leading "#"
 */
export async function activateTagFilterChip(
  page: Page,
  tagName: string,
): Promise<void> {
  const { expect } = await import("@playwright/test");

  const showPanelsBtn = page.getByRole("button", { name: "Show panels" });
  if ((await showPanelsBtn.count()) > 0) {
    await showPanelsBtn.click();
    await expect(showPanelsBtn).toHaveCount(0, { timeout: 3_000 });
  }

  const tabRow = page.getByTestId("right-rail-tab-row");
  await tabRow.getByRole("button", { name: "Tags" }).click();

  const row = page.getByTestId(`tag-row-${tagName}`);
  await row.waitFor({ state: "visible", timeout: 5_000 });
  await row.click();

  await expect(
    page.getByRole("status", { name: `Active filter: #${tagName}` }),
  ).toBeVisible({ timeout: 3_000 });
}
