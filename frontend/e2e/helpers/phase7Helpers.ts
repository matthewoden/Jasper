/**
 * phase7Helpers.ts — Phase 7 UAT helper utilities.
 *
 * Reusable helpers for Phase 7 Playwright E2E scenarios:
 * - pressShortcut: translates symbolic shortcuts to keyboard combos
 * - openCommandMenu: opens Cmd+O (notes) or Cmd+P (commands) modal
 * - apiCreateNote: creates a note via POST /api/v1/notes + PUT /api/v1/notes/{id}
 * - waitForConnected: waits for the WebSocket connection-status dot to show "connected"
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
  | "CmdF"        // Cmd+F — find in note
  | "CmdB"        // Cmd+B — bold
  | "CmdI"        // Cmd+I — italic
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
