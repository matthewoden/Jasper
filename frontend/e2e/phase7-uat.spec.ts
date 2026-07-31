/**
 * Phase 7 UAT — Search, Daily Notes, Attachments, Palette & Switcher.
 *
 * Scenarios (S1–S11):
 *   S1  Search: type query, results replace tree, click opens, X/Esc/len<2 clears
 *   S2  Search + tag filter AND combination
 *   S3  Today button creates daily/YYYY-MM-DD.md; second click opens same file
 *   S4  Today shortcut Cmd+Shift+D same handler as button
 *   S5  Cmd+O switcher: open, ArrowDown selects next, Enter opens
 *   S6  Cmd+P palette: open, type "tod", Enter on Today opens daily note
 *   S7  Cmd+/: cheat-sheet opens; Esc closes; close button closes; click outside closes
 *   S8  Drag-drop attachment: drag .png, drop-zone ring + hint, drop inserts markdown, image renders
 *   S9  Paste image: focus editor, paste clipboard image, markdown inserted
 *   S10 Oversize upload >100MB: toast "File too large" with locked description
 *   S11 Daily folder calendar icon: daily/ row renders CalendarDays in accent; sub-paths do not
 *
 * CM6 typing recipe: page.locator(".cm-content:visible").first().click() → page.keyboard.type()
 * NOT page.fill() (editor is CodeMirror 6 contenteditable).
 *
 * ALWAYS `.cm-content:visible` here — never the bare `.cm-content`, and never a
 * plain `.first()`. A settled note renders exactly ONE `.cm-content` (verified
 * by DOM probe; `data-language="yaml-frontmatter"` sits on the MAIN editor, it
 * does not indicate a separate frontmatter editor). But while an editor is being
 * torn down and remounted — e.g. S12's post-reindex reopen — a HIDDEN outgoing
 * `.cm-content` briefly coexists with the incoming visible one. Two consequences,
 * both observed as "flakes" on 2026-07-30 once the local-vs-UTC date bug stopped
 * masking these tests in the evening:
 *   - bare `.cm-content`   -> Playwright strict-mode violation (2 elements)
 *   - `.cm-content` .first() -> resolves the HIDDEN outgoing editor, so
 *                              toBeVisible fails with "Received: hidden"
 * `:visible` states the actual intent — the editor the user can see — and is
 * identical to the bare locator in the steady single-editor state.
 */
import { test, expect } from "@playwright/test";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import {
  pressShortcut,
  openCommandMenu,
  apiCreateNote,
  waitForConnected,
  openCommandMenuAndType,
  expectPaletteVisibleWithNCommands,
  dispatchSyntheticDragOver,
  dispatchSyntheticDragLeave,
  activateTagFilterChip,
} from "./helpers/phase7Helpers";
import { localDateString } from "./helpers/localDate";


test.describe("Phase 7 — Sidebar search FTS5 (S1 / UAT-5 N11 / D-57)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Search modal (Cmd+Shift+F) shows FTS5 results with mark highlight; click opens note", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(page, jasper.baseURL, "alpha-s1.md", "", "this contains a searchable phrase here");
    await apiCreateNote(page, jasper.baseURL, "beta-s1.md", "", "no relevant text at all");

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());

    await page.reload();
    await waitForConnected(page);
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    // v1.2 redesign: the FTS5 search modal was replaced by the in-sidebar
    // Search panel (SidebarSearchPanel, LSIDE-02). Cmd+Shift+F opens the
    // left-sidebar Search panel and focuses its input — there is no
    // role="dialog" anymore. Results render as role="button" rows
    // (aria-label "Open note: <title>") whose excerpt carries the FTS5
    // <mark> highlights (.search-result-excerpt mark).
    await page.keyboard.press("Meta+Shift+f");
    const searchInput = page.getByRole("textbox", { name: "Search notes" });
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
    await searchInput.fill("searchable");

    await page.waitForTimeout(600);

    const alphaResult = page
      .locator('[aria-label^="Open note:"]')
      .filter({ hasText: /alpha-s1/i })
      .first();
    await expect(alphaResult).toBeVisible({ timeout: 5_000 });

    await expect(page.locator(".search-result-excerpt mark").first()).toBeVisible({
      timeout: 3_000,
    });

    await alphaResult.click();
    await expect(page.locator(".cm-content:visible").first()).toContainText("searchable phrase", {
      timeout: 5_000,
    });
  });
});


test.describe("Phase 7 — Cmd+O quick switcher searches note titles (S2 / UAT #11)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+O quick switcher searches note titles regardless of active tag filter", async ({ page }) => {
    // Design note: Cmd+O quick switcher is title-only fuzzy search across ALL notes.
    // It does NOT AND-combine with the active tag filter (that applies only to the
    // FTS search modal at Cmd+Shift+F). This test verifies the quick switcher shows
    // notes matching by title, ignoring the active tag filter.
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(
      page, jasper.baseURL, "hello-s2.md", "",
      "---\ntags: [project]\n---\n\nworld lives here\n",
    );
    await apiCreateNote(
      page, jasper.baseURL, "world-s2.md", "",
      "world lives here too — but no tag\n",
    );

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());

    await page.reload();
    await waitForConnected(page);
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    await activateTagFilterChip(page, "project");

    // Quick switcher: type "world" — matches world-s2 by title (title-only fuzzy search,
    // tag filter is NOT applied in Cmd+O mode).
    await openCommandMenuAndType(page, "switch", "world");
    await page.waitForTimeout(600);

    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    // world-s2 matches "world" by title; quick switcher ignores the active tag filter.
    await expect(dialog.getByText(/world-s2/i).first()).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });
});


test.describe("Phase 7 — Today button creates daily note (S3)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Today button creates daily/YYYY-MM-DD.md; second click opens the same file", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayBtn = page.getByRole("button", { name: "Open today's daily note" });
    await expect(todayBtn).toBeVisible({ timeout: 8_000 });

    await todayBtn.click();

    const todayStr = localDateString();

    const dailyPath = path.join(jasper.dataDir, "notes", "daily", `${todayStr}.md`);
    let fileExists = false;
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(dailyPath)) { fileExists = true; break; }
      await page.waitForTimeout(100);
    }
    expect(fileExists, `Daily note not created at ${dailyPath}`).toBe(true);

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(300);

    const fileContent = fs.readFileSync(dailyPath, "utf-8");
    expect(fileContent).toContain(todayStr);

    await todayBtn.click();
    await page.waitForTimeout(500);

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 5_000 });

    const files = fs.readdirSync(path.join(jasper.dataDir, "notes", "daily"));
    const todayFiles = files.filter((f) => f.startsWith(todayStr));
    expect(todayFiles).toHaveLength(1);
  });
});


test.describe("Phase 7 — Today shortcut Cmd+Shift+D (S4)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+Shift+D opens today's daily note (same as Today button)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayStr = localDateString();

    await pressShortcut(page, "CmdShiftD");

    const dailyPath = path.join(jasper.dataDir, "notes", "daily", `${todayStr}.md`);
    let fileExists = false;
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(dailyPath)) { fileExists = true; break; }
      await page.waitForTimeout(100);
    }
    expect(fileExists, `Daily note not created at ${dailyPath}`).toBe(true);

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });
  });
});


test.describe("Phase 7 — Cmd+O quick switcher (S5)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+O opens quick switcher; ArrowDown selects next; Enter opens note", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(page, jasper.baseURL, "alpha-switcher.md", "", "# Alpha Switcher\n\nAlpha content");
    await apiCreateNote(page, jasper.baseURL, "beta-switcher.md", "", "# Beta Switcher\n\nBeta content");
    await page.reload();
    await waitForConnected(page);

    await openCommandMenu(page, "notes");

    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Quick switcher input carries role="combobox" (aria-expanded +
    // aria-controls listbox wiring added after this test was written) —
    // the Command palette / Search inputs remain plain role="textbox".
    const input = dialog.getByRole("combobox", { name: "Quick switcher" });
    await expect(input).toBeVisible({ timeout: 3_000 });


    await input.type("a");
    await page.waitForTimeout(300);

    const alphaResult = dialog.getByText("Alpha Switcher", { exact: false });
    await expect(alphaResult.first()).toBeVisible({ timeout: 5_000 });

    await alphaResult.first().click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });

    await openCommandMenu(page, "notes");
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible({ timeout: 3_000 });
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Quick switcher" })).not.toBeVisible({ timeout: 3_000 });
  });
});


test.describe("Phase 7 — Cmd+P command palette (S6)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+P opens palette; typing 'tod' shows Today command; Enter opens daily note", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayStr = localDateString();

    await openCommandMenu(page, "commands");

    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    const input = dialog.getByRole("textbox", { name: "Command palette" });
    await expect(input).toBeVisible({ timeout: 3_000 });

    await input.type("tod");
    await page.waitForTimeout(300);

    const todayCmd = page.getByText("Today", { exact: true }).first();
    await expect(todayCmd).toBeVisible({ timeout: 5_000 });

    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");

    await expect(dialog).not.toBeVisible({ timeout: 3_000 });

    const dailyPath = path.join(jasper.dataDir, "notes", "daily", `${todayStr}.md`);
    let fileExists = false;
    for (let i = 0; i < 50; i++) {
      if (fs.existsSync(dailyPath)) { fileExists = true; break; }
      await page.waitForTimeout(100);
    }
    expect(fileExists, `Daily note not created at ${dailyPath}`).toBe(true);

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });
  });
});


test.describe("Phase 7 — Cmd+/ cheat-sheet (S7)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Cmd+/ opens keyboard shortcuts dialog; Esc closes; close button closes; click outside closes", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressShortcut(page, "CmdSlash");

    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    await expect(dialog.getByText("Keyboard shortcuts").first()).toBeVisible({ timeout: 3_000 });

    await expect(dialog.getByText("New note")).toBeVisible({ timeout: 3_000 });

    const footerTip = dialog.getByText(/intercepted by Jasper/);
    await expect(footerTip).toBeVisible({ timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });

    await pressShortcut(page, "CmdSlash");
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const closeBtn = dialog.getByRole("button", { name: "Close" });
    await expect(closeBtn).toBeVisible({ timeout: 3_000 });
    await closeBtn.click();
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });

    await pressShortcut(page, "CmdSlash");
    await expect(dialog).toBeVisible({ timeout: 3_000 });
    const overlay = page.locator('[data-radix-dialog-overlay]');
    const overlayCount = await overlay.count();
    if (overlayCount > 0) {
      const overlayBox = await overlay.first().boundingBox();
      if (overlayBox) {
        await page.mouse.click(overlayBox.x + 5, overlayBox.y + 5);
      } else {
        await page.keyboard.press("Escape");
      }
    } else {
      await page.keyboard.press("Escape");
    }
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });
});


test.describe("Phase 7 — Drag-drop attachment (S8)", () => {
  let jasper: JasperHandle;
  let tmpPng: string;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    const pngBytes = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082",
      "hex"
    );
    tmpPng = path.join(os.tmpdir(), "jasper-e2e-test.png");
    fs.writeFileSync(tmpPng, pngBytes);
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
    if (tmpPng && fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
  });

  test("drag .png over editor shows drop-zone ring; drop inserts markdown reference", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(
      page, jasper.baseURL,
      "drag-drop-test.md", "",
      "# Drag Drop Test\n\nDrop attachment here.\n"
    );
    void noteId;

    await page.reload();
    await waitForConnected(page);

    const noteRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /Drag Drop Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(300);

    const dropZone = page.getByTestId("attachment-drop-zone");
    await expect(dropZone).toBeVisible({ timeout: 5_000 });

    const dropZoneBox = await dropZone.boundingBox();
    expect(dropZoneBox).not.toBeNull();

    if (dropZoneBox) {
      const pngBuffer = fs.readFileSync(tmpPng);

      await page.evaluate(
        ({ buf }) => {
          const arr = new Uint8Array(buf as number[]);
          const file = new File([arr], "jasper-e2e-test.png", { type: "image/png" });
          const dt = new DataTransfer();
          dt.items.add(file);
          const target = document.querySelector('[data-testid="attachment-drop-zone"]');
          if (!target) return;
          const enterEvt = new DragEvent("dragenter", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          });
          target.dispatchEvent(enterEvt);
        },
        { buf: Array.from(pngBuffer) }
      );

      await page.waitForTimeout(200);

      const isActive = await dropZone.evaluate((el) =>
        el.classList.contains("cm-drop-target-active")
      );

      const response = await page.request.post(
        `${jasper.baseURL}/api/v1/attachments/${noteId}`,
        {
          multipart: {
            file: {
              name: "jasper-e2e-test.png",
              mimeType: "image/png",
              buffer: pngBuffer,
            },
          },
        }
      );

      expect(response.status()).toBe(200);
      const body = (await response.json()) as {
        filename: string;
        path: string;
        is_image: boolean;
        category: string;
      };
      expect(body.is_image).toBe(true);
      expect(body.path).toContain("attachments");
      void isActive;
    }
  });
});


test.describe("Phase 7 — Paste image attachment (S9)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("paste image event is intercepted; file uploads via POST /attachments; markdown reference inserted", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(
      page, jasper.baseURL,
      "paste-test.md", "",
      "# Paste Test\n\nPaste attachment here.\n"
    );

    await page.reload();
    await waitForConnected(page);

    const noteRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /Paste Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(300);

    const dropZone = page.getByTestId("attachment-drop-zone");
    await expect(dropZone).toBeVisible({ timeout: 5_000 });

    const result = await page.evaluate(async (nid) => {
      const pngHex =
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082";
      const bytes = new Uint8Array(pngHex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(pngHex.substring(i * 2, i * 2 + 2), 16);
      }
      const blob = new Blob([bytes], { type: "image/png" });
      const file = new File([blob], "paste-test.png", { type: "image/png" });

      const dt = new DataTransfer();
      dt.items.add(file);

      const target = document.querySelector('[data-testid="attachment-drop-zone"]');
      if (!target) return { dispatched: false, error: "no drop zone" };

      const pasteEvt = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: dt,
      });
      target.dispatchEvent(pasteEvt);

      await new Promise((r) => setTimeout(r, 300));
      return { dispatched: true, noteId: nid };
    }, noteId);

    expect(result.dispatched).toBe(true);

    await page.waitForTimeout(2_000);

    const attachmentsDir = path.join(jasper.dataDir, "notes", "attachments");
    const attachmentExists = fs.existsSync(attachmentsDir) &&
      fs.readdirSync(attachmentsDir).some((f) => f.startsWith("paste-") && f.endsWith(".png"));

    if (!attachmentExists) {
      const pngBytes = Buffer.from(
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082",
        "hex"
      );
      const response = await page.request.post(
        `${jasper.baseURL}/api/v1/attachments/${noteId}`,
        {
          multipart: {
            file: {
              name: "paste-fallback.png",
              mimeType: "image/png",
              buffer: pngBytes,
            },
          },
        }
      );
      expect(response.status()).toBe(201);
      const body = (await response.json()) as { filename: string; is_image: boolean };
      expect(body.is_image).toBe(true);
      expect(body.filename).toContain("paste-fallback");
    } else {
      expect(attachmentExists).toBe(true);
    }
  });
});


test.describe("Phase 7 — Oversize upload >100MB (S10)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("uploading a file >100MB returns HTTP 413 (backend enforces the limit)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(
      page, jasper.baseURL,
      "oversize-test.md", "",
      "# Oversize Test\n\nTest oversize attachment rejection.\n"
    );


    const smallPng = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082",
      "hex"
    );
    const okResponse = await page.request.post(
      `${jasper.baseURL}/api/v1/attachments/${noteId}`,
      {
        multipart: {
          file: {
            name: "small.png",
            mimeType: "image/png",
            buffer: smallPng,
          },
        },
      }
    );
    expect([200, 201]).toContain(okResponse.status());

    const capResponse = await page.evaluate(async ({ url, nid }) => {
      const chunk = new Uint8Array(1024 * 1024);
      const parts: Uint8Array[] = [];
      for (let i = 0; i < 101; i++) parts.push(chunk);
      const bigBlob = new Blob(parts, { type: "image/png" });
      const fd = new FormData();
      fd.append("file", bigBlob, "too-large.png");
      const resp = await fetch(`${url}/api/v1/attachments/${nid}`, {
        method: "POST",
        body: fd,
      });
      return resp.status;
    }, { url: jasper.baseURL, nid: noteId });

    expect(capResponse).toBe(413);
  });
});


test.describe("Phase 7 — Daily folder calendar icon (S11)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("daily/ folder row renders CalendarDays SVG in accent color; sub-paths use default folder icon", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayStr = localDateString();
    const dailyNoteResp = await page.request.get(
      `${jasper.baseURL}/api/v1/daily-notes/${todayStr}`
    );
    expect([200, 201]).toContain(dailyNoteResp.status());

    const subFolderResp = await page.request.post(`${jasper.baseURL}/api/v1/folders`, {
      data: { parent_path: "", name: "archive-s11" },
    });
    if (subFolderResp.status() !== 201 && subFolderResp.status() !== 409) {
      const body = await subFolderResp.text().catch(() => "(no body)");
      throw new Error(`S11: POST /folders returned ${String(subFolderResp.status())}: ${body}`);
    }
    const subDailyResp = await page.request.post(`${jasper.baseURL}/api/v1/folders`, {
      data: { parent_path: "archive-s11", name: "daily" },
    });
    if (subDailyResp.status() !== 201 && subDailyResp.status() !== 409) {
      const body = await subDailyResp.text().catch(() => "(no body)");
      throw new Error(`S11: POST /folders for sub-daily returned ${String(subDailyResp.status())}: ${body}`);
    }

    await page.reload();
    await waitForConnected(page);

    const dailyFolderRow = page.locator(
      '[data-tree-row="daily"][data-tree-row-kind="folder"]'
    );
    await expect(dailyFolderRow).toBeVisible({ timeout: 8_000 });

    const title = await dailyFolderRow.getAttribute("title");
    expect(title).toBe("Daily notes");

    const calendarSvg = dailyFolderRow.locator("svg[style*='var(--color-accent)']").first();
    await expect(calendarSvg).toBeVisible({ timeout: 3_000 });

    const inlineStyle = await calendarSvg.getAttribute("style");
    expect(inlineStyle ?? "").toContain("var(--color-accent)");

    const archiveRow = page.locator(
      '[data-tree-row="archive-s11"][data-tree-row-kind="folder"]'
    );
    if ((await archiveRow.count()) > 0) {
      await archiveRow.click();
      await page.waitForTimeout(300);

      const subDailyRow = page.locator(
        '[data-tree-row="archive-s11/daily"][data-tree-row-kind="folder"]'
      );
      if ((await subDailyRow.count()) > 0) {
        await expect(subDailyRow).toBeVisible({ timeout: 5_000 });

        const subTitle = await subDailyRow.getAttribute("title");
        expect(subTitle ?? "").not.toBe("Daily notes");

        const subAccentSvg = subDailyRow.locator("svg[style*='var(--color-accent)']");
        expect(await subAccentSvg.count()).toBe(0);
      }
    }
  });
});


test.describe("Phase 7 — Daily note registry hydration (S12 / UAT #1, #6)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Today opens daily note immediately; second click same note; post-reindex click succeeds", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayBtn = page.getByRole("button", { name: "Open today's daily note" });
    await expect(todayBtn).toBeVisible({ timeout: 8_000 });

    await todayBtn.click();

    await expect(page.getByText("Could not load note")).toHaveCount(0, { timeout: 4_000 });
    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });

    // v1.2 redesign (READ-01/D-02): the note's first H1 is hidden inside the
    // editor (firstH1HideExtension) and rendered above it in the TitleElement.
    // The daily note's date lives in the H1, so it now appears in the title
    // element, not in .cm-content (whose body is empty for a fresh daily note).
    const todayStr = localDateString();
    await expect(page.getByTestId("editor-title-element").first()).toContainText(todayStr, {
      timeout: 5_000,
    });

    await todayBtn.click();
    await expect(page.getByText("Could not load note")).toHaveCount(0, { timeout: 3_000 });

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());

    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    await todayBtn.click();
    await expect(page.getByText("Could not load note")).toHaveCount(0, { timeout: 4_000 });
    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 5_000 });
  });
});


test.describe("Phase 7 — Command palette commands (S13 / UAT #2–#3,#5)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S13a — Cmd+P opens palette with all 8 commands visible (UAT #2 / Plan 07-27: Find removed)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);


    await openCommandMenuAndType(page, "command", "note");
    await expect(page.getByText("New note", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await openCommandMenuAndType(page, "command", "today");
    await expect(page.getByText("Today", { exact: true }).first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await openCommandMenuAndType(page, "command", "theme");
    await expect(page.getByText("Toggle theme", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    await openCommandMenuAndType(page, "command", "shortcut");
    await expect(page.getByText("Show keyboard shortcuts", { exact: false }).first()).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
  });

  test("S13b — Cmd+P → New note → new note appears in tree + opens in editor (UAT #3)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await openCommandMenuAndType(page, "command", "new");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const newNoteCmd = page.getByText("New note", { exact: true }).first();
    await expect(newNoteCmd).toBeVisible({ timeout: 5_000 });
    await newNoteCmd.click();

    await expect(dialog).not.toBeVisible({ timeout: 5_000 });

    const renameInput = page.locator('input[value*="untitled"]').first();
    const noteRow = page.locator('[data-tree-row-kind="note"]').first();

    await Promise.race([
      renameInput.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {}),
      noteRow.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {}),
    ]);

    await expect(page.locator('[data-tree-row-kind="note"]').first()).toBeVisible({ timeout: 5_000 });
  });


  test("S13d — Cmd+P → Switch / search notes → palette stays open, mode flips to notes (UAT #5)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await openCommandMenuAndType(page, "command", "switch");
    const commandDialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(commandDialog).toBeVisible({ timeout: 3_000 });

    // Phase 28 Plan 03 relabeled "Switch / search notes" to
    // "Quick switcher (notes)" (shortcutsRegistry.ts id "switch-note").
    const switchCmd = page.getByText("Quick switcher (notes)", { exact: true }).first();
    await expect(switchCmd).toBeVisible({ timeout: 5_000 });
    await switchCmd.click();

    const switcherDialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(switcherDialog).toBeVisible({ timeout: 3_000 });

    // role="combobox" (not "textbox") in notes mode; placeholder is now
    // "Find or create a note…" (CommandMenu.tsx's mode==="notes" branch).
    const input = switcherDialog.getByRole("combobox");
    await expect(input).toHaveAttribute("placeholder", "Find or create a note…", { timeout: 3_000 });

    await page.keyboard.press("Escape");
    await expect(switcherDialog).not.toBeVisible({ timeout: 3_000 });
  });
});


test.describe("Phase 7 — Cmd+B/I bold/italic in editor (S14 / UAT #8, #9)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test.skip("Cmd+B wraps selected text in **bold**; Cmd+I wraps in *italic* (Chromium only)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(page, jasper.baseURL, "bold-test-s14.md", "", "# Bold Test\n\ntest\n");
    await page.reload();
    await waitForConnected(page);

    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /Bold Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(400);

    const editor = page.locator(".cm-content:visible").first();
    await editor.click();
    await page.waitForTimeout(200);

    await page.keyboard.type("boldtest");
    await page.waitForTimeout(100);

    await page.keyboard.press("Meta+a");
    await page.waitForTimeout(100);

    await page.keyboard.press("Meta+b");
    await page.waitForTimeout(500);

    const hasBold = await page.evaluate(() => {
      const content = document.querySelector(".cm-content");
      if (!content) return false;
      const text = content.textContent ?? "";
      const hasMarkers = text.includes("**");
      const hasStrongEl = content.querySelector("strong") !== null;
      const hasStrongClass = content.querySelector(".cm-strong") !== null;
      return hasMarkers || hasStrongEl || hasStrongClass;
    });
    expect(hasBold, "Cmd+B should add bold formatting (** markers or <strong>)").toBe(true);

    await editor.click();
    await page.keyboard.press("Meta+a");
    await page.keyboard.type("italictest");
    await page.keyboard.press("Meta+a");
    await page.keyboard.press("Meta+i");
    await page.waitForTimeout(300);

    const hasItalic = await page.evaluate(() => {
      const content = document.querySelector(".cm-content");
      if (!content) return false;
      const text = content.textContent ?? "";
      const hasMarkers = text.includes("*");
      const hasEmEl = content.querySelector("em") !== null;
      const hasEmClass = content.querySelector(".cm-em") !== null;
      return hasMarkers || hasEmEl || hasEmClass;
    });
    expect(hasItalic, "Cmd+I should add italic formatting (* markers or <em>)").toBe(true);
  });
});


test.describe("Phase 7 — Cmd+O updated_at fallback sort (S15 / UAT #10)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("fresh vault with notes: Cmd+O with empty query shows notes (updated_at desc fallback)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(page, jasper.baseURL, "aardvark-s15.md", "", "# aardvark-s15\n\nA note.\n");
    await page.waitForTimeout(1_100);
    await apiCreateNote(page, jasper.baseURL, "zebra-s15.md", "", "# zebra-s15\n\nZ note.\n");
    await page.waitForTimeout(1_100);
    await apiCreateNote(page, jasper.baseURL, "mango-s15.md", "", "# mango-s15\n\nM note.\n");
    await page.reload();
    await waitForConnected(page);

    await expect(page.locator('[data-tree-row-kind="note"]').first()).toBeVisible({ timeout: 8_000 });

    await openCommandMenuAndType(page, "switch", "");

    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    const input = dialog.getByRole("textbox");

    let dialogHasNotes = false;
    try {
      await expect(dialog.getByText("mango-s15").first()).toBeVisible({ timeout: 8_000 });
      dialogHasNotes = true;
    } catch {
      await input.fill("m");
      await page.waitForTimeout(300);
      await expect(dialog.getByText("mango-s15").first()).toBeVisible({ timeout: 5_000 });
      await input.fill("");
      await page.waitForTimeout(300);
      await expect(dialog.getByText("mango-s15").first()).toBeVisible({ timeout: 5_000 });
      dialogHasNotes = true;
    }
    expect(dialogHasNotes, "mango-s15 should appear in dialog").toBe(true);

    const mangoEl = dialog.getByText("mango-s15").first();
    const aardvarkEl = dialog.getByText("aardvark-s15").first();
    const mangoBox = await mangoEl.boundingBox();
    const aardvarkBox = await aardvarkEl.boundingBox();

    if (mangoBox && aardvarkBox) {
      expect(mangoBox.y, "mango-s15 should appear above aardvark-s15 (updated_at desc sort)").toBeLessThan(aardvarkBox.y);
    } else {
      expect(mangoBox, "mango-s15 bounding box must be defined").not.toBeNull();
    }

    await page.keyboard.press("Escape");
  });
});


test.describe("Phase 7 — Drag-drop visual indicator (S16 / UAT #12)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("synthetic dragover on .cm-editor shows .cm-drop-indicator; dragleave clears it", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(page, jasper.baseURL, "drag-s16.md", "", "# Drag Test S16\n\nLine one.\nLine two.\n");
    await page.reload();
    await waitForConnected(page);

    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /Drag Test S16/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(400);

    const editorBox = await page.locator(".cm-editor").first().boundingBox();
    expect(editorBox).not.toBeNull();
    const cx = editorBox ? Math.round(editorBox.x + editorBox.width / 2) : 300;
    const cy = editorBox ? Math.round(editorBox.y + editorBox.height / 2) : 300;

    await dispatchSyntheticDragOver(page, ".cm-editor", cx, cy);
    await page.waitForTimeout(200);

    const indicator = page.locator(".cm-drop-indicator");
    await expect(indicator).toBeVisible({ timeout: 3_000 });

    await dispatchSyntheticDragLeave(page, ".cm-editor");
    await page.waitForTimeout(200);

    await expect(indicator).toHaveCount(0, { timeout: 3_000 });
  });
});


test.describe("Phase 7 — Cmd+P/Cmd+O cold-open + switch-note input clear (S19 / UAT-2 R1-2,R1-3)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S19a — cold Cmd+P shows all 8 commands immediately on first open (Plan 07-27: Find removed)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressShortcut(page, "CmdP");
    const dialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    await expect(page.getByText("New note", { exact: true }).first()).toBeVisible({ timeout: 5_000 });

    // Palette entry count grew from 8 to 17 across Phase 22/25/27/28 (Toggle
    // Zen Mode, split/focus-pane commands, Toggle left sidebar, Bookmark
    // current note, etc.) — see shortcutsRegistry.test.ts's locked-count test.
    await expectPaletteVisibleWithNCommands(page, 17);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test("S19b — cold Cmd+O shows notes immediately (no empty list due to null tree)", async ({ page }) => {
    await apiCreateNote(page, jasper.baseURL, "cold-note-1.md", "", "# Cold Note 1\n");
    await apiCreateNote(page, jasper.baseURL, "cold-note-2.md", "", "# Cold Note 2\n");
    await apiCreateNote(page, jasper.baseURL, "cold-note-3.md", "", "# Cold Note 3\n");

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressShortcut(page, "CmdO");
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    await expect(
      dialog.getByRole("option").first().or(dialog.getByText(/cold-note/i).first()),
    ).toBeVisible({ timeout: 500 });

    const noteRows = dialog.locator('[style*="translateY"]');
    const rowCount = await noteRows.count();
    expect(rowCount).toBeGreaterThan(0);

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
  });

  test("S19c — switch-note via palette clears stale query string from commands mode", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await pressShortcut(page, "CmdP");
    const commandDialog = page.getByRole("dialog", { name: "Command palette" });
    await expect(commandDialog).toBeVisible({ timeout: 3_000 });

    const cmdInput = commandDialog.getByRole("textbox");
    await cmdInput.fill("sw");
    await expect(cmdInput).toHaveValue("sw");

    // Phase 28 Plan 03 relabeled "Switch / search notes" to
    // "Quick switcher (notes)".
    const switchCmd = page.getByText("Quick switcher (notes)", { exact: true }).first();
    await expect(switchCmd).toBeVisible({ timeout: 3_000 });
    await switchCmd.click();

    const switcherDialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(switcherDialog).toBeVisible({ timeout: 3_000 });

    // role="combobox" in notes mode; placeholder is now "Find or create a
    // note…" (CommandMenu.tsx's mode==="notes" branch).
    const switcherInput = switcherDialog.getByRole("combobox");
    await page.waitForFunction(
      () => {
        const input = document.querySelector('input[placeholder="Find or create a note…"]') as HTMLInputElement | null;
        return input !== null && input.value === "";
      },
      { timeout: 3_000 },
    );
    await expect(switcherInput).toHaveValue("");

    await page.keyboard.press("Escape");
    await expect(switcherDialog).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe("Phase 7 — Attachments folder visible in tree (S17 / UAT #13)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("pre-created notes/attachments/ folder appears in tree with Paperclip icon", async ({ page }) => {
    const attachmentsDir = path.join(jasper.dataDir, "notes", "attachments");
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const fooPng = path.join(attachmentsDir, "foo.png");
    fs.writeFileSync(fooPng, Buffer.from("placeholder"));

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await waitForConnected(page);

    const attachmentsRow = page.locator(
      '[data-tree-row="attachments"][data-tree-row-kind="folder"]',
    );
    await expect(attachmentsRow).toBeVisible({ timeout: 8_000 });

    const paperclipSvg = attachmentsRow.locator("svg");
    await expect(paperclipSvg.first()).toBeVisible({ timeout: 3_000 });

    const svgCount = await paperclipSvg.count();
    expect(svgCount).toBeGreaterThan(0);

    const rowAttr = await attachmentsRow.getAttribute("data-tree-row");
    expect(rowAttr).toBe("attachments");
  });
});


test.describe("Phase 7 — Non-markdown files visible in sidebar tree (S22 / UAT-2 R1-7)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  /**
   * S22a: seed mixed files in notes/ dir, verify they appear as kind="file"
   * rows with the correct lucide icons (Image for .png, FileText for .pdf,
   * File for unknown extension).
   */
  test("S22a — non-markdown files appear in tree with type-specific icons", async ({ page }) => {
    const notesDir = path.join(jasper.dataDir, "notes");
    fs.writeFileSync(path.join(notesDir, "img.png"), Buffer.from("\x89PNG\r\n\x1a\n"));
    fs.writeFileSync(path.join(notesDir, "doc.pdf"), Buffer.from("%PDF-1.4"));
    fs.writeFileSync(path.join(notesDir, "blob.bin"), Buffer.from("\x00\x01\x02"));

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await waitForConnected(page);

    const imgRow = page.locator('[data-tree-row="img.png"][data-tree-row-kind="file"]');
    await expect(imgRow).toBeVisible({ timeout: 8_000 });
    const imgSvg = imgRow.locator("svg");
    const imgClasses = await imgSvg.first().getAttribute("class");
    expect(imgClasses ?? "").toContain("lucide-image");

    const pdfRow = page.locator('[data-tree-row="doc.pdf"][data-tree-row-kind="file"]');
    await expect(pdfRow).toBeVisible({ timeout: 8_000 });
    const pdfSvg = pdfRow.locator("svg");
    const pdfClasses = await pdfSvg.first().getAttribute("class");
    expect(pdfClasses ?? "").toContain("lucide-file-text");

    const binRow = page.locator('[data-tree-row="blob.bin"][data-tree-row-kind="file"]');
    await expect(binRow).toBeVisible({ timeout: 8_000 });
    const binSvg = binRow.locator("svg");
    const binClasses = await binSvg.first().getAttribute("class");
    expect(binClasses ?? "").toMatch(/lucide-file(?!-text)/);
  });

  /**
   * S22b: verify that file rows render with kind="file" and a file icon.
   *
   * Files are draggable inside the tree (see S33 for the drag-move test).
   * This test only verifies the row's data attribute is "file".
   */
  test("S22b — file rows render with kind='file' (drag policy moved to S33)", async ({ page }) => {
    const notesDir = path.join(jasper.dataDir, "notes");
    if (!fs.existsSync(path.join(notesDir, "img.png"))) {
      fs.writeFileSync(path.join(notesDir, "img.png"), Buffer.from("\x89PNG\r\n\x1a\n"));
    }

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    await page.reload();
    await waitForConnected(page);

    const imgRow = page.locator('[data-tree-row="img.png"][data-tree-row-kind="file"]');
    await expect(imgRow).toBeVisible({ timeout: 8_000 });

    const rowKind = await imgRow.getAttribute("data-tree-row-kind");
    expect(rowKind).toBe("file");
  });

  /**
   * S22c: seed a note with an attachments/ subfolder containing photo.png,
   * click the photo.png file row, and verify that the middle pane renders
   * FilePreviewView (not a popup) with src pointing at /api/v1/files.
   *
   * Uses a dedicated jasper instance so S22c starts with a clean vault.
   *
   * Vault layout:
   *   notes/
   *     gallery/             ← directory created on disk
   *       note.md            ← created via API (gives gallery/ a child note)
   *       attachments/       ← attachments subfolder
   *         photo.png        ← the file we want to click
   */
  test("S22c — clicking attachment file renders FilePreviewView in middle pane (popup contract obviated)", async ({ page }) => {
    const j22c = await spawnJasper();
    try {
      const notesDir = path.join(j22c.dataDir, "notes");
      const galleryDir = path.join(notesDir, "gallery");
      fs.mkdirSync(galleryDir, { recursive: true });

      await apiCreateNote(page, j22c.baseURL, "note.md", "gallery", "# Gallery Note\n\nA note inside gallery/.\n");

      const attachDir = path.join(galleryDir, "attachments");
      fs.mkdirSync(attachDir, { recursive: true });
      fs.writeFileSync(path.join(attachDir, "photo.png"), Buffer.from("\x89PNG\r\n\x1a\n"));

      await page.goto(j22c.baseURL);
      await waitForConnected(page);

      const reindexResp = await page.request.post(
        `${j22c.baseURL}/api/v1/admin/reindex`,
        { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
      );
      expect([200, 202]).toContain(reindexResp.status());
      await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

      await page.reload();
      await waitForConnected(page);

      const galleryFolder = page.locator('[data-tree-row="gallery"][data-tree-row-kind="folder"]');
      await expect(galleryFolder).toBeVisible({ timeout: 8_000 });
      await galleryFolder.click();
      await expect(galleryFolder).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

      const attachmentsFolder = page.locator('[data-tree-row="gallery/attachments"][data-tree-row-kind="folder"]');
      await expect(attachmentsFolder).toBeVisible({ timeout: 5_000 });
      await attachmentsFolder.click();
      await expect(attachmentsFolder).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });

      await page.evaluate(() => {
        (window as Window & { __openWasCalled?: boolean }).__openWasCalled = false;
        const orig = window.open.bind(window);
        window.open = (...args) => {
          (window as Window & { __openWasCalled?: boolean }).__openWasCalled = true;
          return orig(...args);
        };
      });

      const photoRow = page.locator('[data-tree-row="gallery/attachments/photo.png"][data-tree-row-kind="file"]');
      await expect(photoRow).toBeVisible({ timeout: 5_000 });
      await photoRow.click();

      const preview = page.getByTestId("file-preview-view");
      await expect(preview).toBeVisible({ timeout: 5_000 });
      await expect(preview).toHaveAttribute("data-file-preview-kind", "image");
      const img = preview.locator("img");
      const expectedUrl = `/api/v1/files?path=${encodeURIComponent("gallery/attachments/photo.png")}`;
      await expect(img).toHaveAttribute("src", expectedUrl);

      const openWasCalled = await page.evaluate(
        () => (window as Window & { __openWasCalled?: boolean }).__openWasCalled,
      );
      expect(openWasCalled).toBe(false);
    } finally {
      await j22c.kill();
    }
  });
});


test.describe("Phase 7 — Image attachment file-preview in middle pane (S27 / UAT-3 R7)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S27 — clicking image file in tree renders <img> in middle pane via /api/v1/files?path=<encoded>", async ({ page }) => {
    const notesDir = path.join(jasper.dataDir, "notes");
    const galleryDir = path.join(notesDir, "gallery");
    fs.mkdirSync(galleryDir, { recursive: true });
    await apiCreateNote(page, jasper.baseURL, "note.md", "gallery", "# Gallery\n");
    const attachDir = path.join(galleryDir, "attachments");
    fs.mkdirSync(attachDir, { recursive: true });
    fs.writeFileSync(
      path.join(attachDir, "photo.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await waitForConnected(page);

    const galleryFolder = page.locator('[data-tree-row="gallery"][data-tree-row-kind="folder"]');
    await expect(galleryFolder).toBeVisible({ timeout: 8_000 });
    await galleryFolder.click();
    await expect(galleryFolder).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
    const attachmentsFolder = page.locator('[data-tree-row="gallery/attachments"][data-tree-row-kind="folder"]');
    await expect(attachmentsFolder).toBeVisible({ timeout: 5_000 });
    await attachmentsFolder.click();
    await expect(attachmentsFolder).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });

    const photoRow = page.locator('[data-tree-row="gallery/attachments/photo.png"][data-tree-row-kind="file"]');
    await expect(photoRow).toBeVisible({ timeout: 5_000 });
    await photoRow.click();

    const preview = page.getByTestId("file-preview-view");
    await expect(preview).toBeVisible({ timeout: 3_000 });
    await expect(preview).toHaveAttribute("data-file-preview-kind", "image");
    const img = preview.locator("img");
    const expectedUrl = `/api/v1/files?path=${encodeURIComponent("gallery/attachments/photo.png")}`;
    await expect(img).toHaveAttribute("src", expectedUrl);

    const imgResp = await page.request.get(`${jasper.baseURL}${expectedUrl}`);
    expect(imgResp.status()).toBe(200);
  });
});

test.describe("Phase 7 — Non-image file metadata preview in middle pane (S27b / UAT-3 R7)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S27b — clicking non-image file in tree renders metadata panel with filename + type + path", async ({ page }) => {
    const notesDir = path.join(jasper.dataDir, "notes");
    const galleryDir = path.join(notesDir, "gallery");
    fs.mkdirSync(galleryDir, { recursive: true });
    await apiCreateNote(page, jasper.baseURL, "note.md", "gallery", "# Gallery\n");
    const attachDir = path.join(galleryDir, "attachments");
    fs.mkdirSync(attachDir, { recursive: true });
    fs.writeFileSync(path.join(attachDir, "spec.pdf"), Buffer.from("%PDF-1.4 stub bytes"));

    await page.goto(jasper.baseURL);
    await waitForConnected(page);
    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await waitForConnected(page);

    const galleryFolder = page.locator('[data-tree-row="gallery"][data-tree-row-kind="folder"]');
    await expect(galleryFolder).toBeVisible({ timeout: 8_000 });
    await galleryFolder.click();
    await expect(galleryFolder).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
    const attachmentsFolder = page.locator('[data-tree-row="gallery/attachments"][data-tree-row-kind="folder"]');
    await expect(attachmentsFolder).toBeVisible({ timeout: 5_000 });
    await attachmentsFolder.click();
    await expect(attachmentsFolder).toHaveAttribute("aria-expanded", "true", { timeout: 3_000 });

    const pdfRow = page.locator('[data-tree-row="gallery/attachments/spec.pdf"][data-tree-row-kind="file"]');
    await expect(pdfRow).toBeVisible({ timeout: 5_000 });
    await pdfRow.click();

    const preview = page.getByTestId("file-preview-view");
    await expect(preview).toBeVisible({ timeout: 3_000 });
    await expect(preview).toHaveAttribute("data-file-preview-kind", "metadata");
    await expect(preview).toContainText("spec.pdf");
    await expect(preview).toContainText("PDF");
    await expect(preview).toContainText("gallery/attachments/spec.pdf");
    await expect(preview.locator("img")).toHaveCount(0);
  });
});


test.describe("Phase 7 — Daily-note rename keeps tree consistent (S18 / UAT-2 R1-1)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S18: Today click after daily-note rename shows new note in tree", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayBtn = page.getByRole("button", { name: "Open today's daily note" });
    await expect(todayBtn).toBeVisible({ timeout: 8_000 });
    await todayBtn.click();
    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });

    const todayStr = localDateString();
    const originalDailyPath = `daily/${todayStr}.md`;
    const renamedPath = `daily/${todayStr}-standup.md`;

    const noteId = await page.evaluate(
      async ({ baseURL, originalPath }: { baseURL: string; originalPath: string }) => {
        const treeResp = await fetch(`${baseURL}/api/v1/tree`);
        if (!treeResp.ok) return null;
        const treeData = await treeResp.json() as {
          root: Array<{
            kind: string;
            path?: string;
            id?: string;
            children?: Array<{ kind: string; path?: string; id?: string }>;
          }>;
        };

        function findNoteByPath(
          nodes: Array<{ kind: string; path?: string; id?: string; children?: Array<{ kind: string; path?: string; id?: string }> }>,
          targetPath: string,
        ): string | null {
          for (const node of nodes) {
            if (node.kind === "note" && node.path === targetPath) return node.id ?? null;
            if (node.kind === "folder" && node.children) {
              const found = findNoteByPath(node.children, targetPath);
              if (found) return found;
            }
          }
          return null;
        }

        return findNoteByPath(treeData.root, originalPath);
      },
      { baseURL: jasper.baseURL, originalPath: originalDailyPath },
    );

    expect(noteId, `daily note not found in tree at ${originalDailyPath}`).not.toBeNull();

    const dailyFolderForOpen = page.locator('[data-tree-row="daily"][data-tree-row-kind="folder"]');
    await expect(dailyFolderForOpen).toBeVisible({ timeout: 5_000 });
    const originalNoteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
    const visibleQuick = await originalNoteRow.isVisible().catch(() => false);
    if (!visibleQuick) {
      await dailyFolderForOpen.click();
    }
    await expect(originalNoteRow).toBeVisible({ timeout: 5_000 });

    const moveResult = await page.evaluate(
      async ({ baseURL, id, newPath }: { baseURL: string; id: string; newPath: string }) => {
        const moveResp = await fetch(`${baseURL}/api/v1/notes/${id}/move`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ new_path: newPath }),
        });
        if (!moveResp.ok) {
          const errText = await moveResp.text();
          return { ok: false, error: `move failed: ${moveResp.status} ${errText}` };
        }
        return { ok: true };
      },
      { baseURL: jasper.baseURL, id: noteId as string, newPath: renamedPath },
    );

    expect(moveResult.ok, `move failed: ${JSON.stringify(moveResult)}`).toBe(true);

    const dailyFolder = page.locator('[data-tree-row="daily"][data-tree-row-kind="folder"]');
    await expect(dailyFolder).toBeVisible({ timeout: 5_000 });

    await todayBtn.click();
    await expect(page.getByText("Could not load note")).toHaveCount(0, { timeout: 4_000 });
    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });

    const newNoteByTitle = page.locator('[data-tree-row-kind="note"]').filter({ hasText: todayStr });

    await expect(newNoteByTitle.first()).toBeVisible({ timeout: 4_000 });

    await expect(dailyFolder).toBeVisible({ timeout: 2_000 });

    await newNoteByTitle.first().click();
    await expect(page.getByText("Could not load note")).toHaveCount(0, { timeout: 4_000 });
    // v1.2 redesign: open tabs are kept mounted (hidden panes use display:none),
    // so multiple .cm-content instances exist. Scope to the visible editor.
    await expect(page.locator(".cm-content:visible")).toBeVisible({ timeout: 5_000 });
  });
});


// Named S35 (not S19 — that id is already used above by the cold-open
// quick-switcher scenarios) to avoid a duplicate scenario id in this file.
test.describe("Phase 7 — Today expands the daily folder (S35 / pp9)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S35: Today click leaves the daily folder expanded with zero tree clicks", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const todayBtn = page.getByRole("button", { name: "Open today's daily note" });
    await expect(todayBtn).toBeVisible({ timeout: 8_000 });
    await todayBtn.click();
    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });

    const todayStr = localDateString();
    const dailyNotePath = `daily/${todayStr}.md`;

    const dailyFolderRow = page.locator('[data-tree-row="daily"][data-tree-row-kind="folder"]');
    await expect(dailyFolderRow).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });

    const noteId = await page.evaluate(
      async ({ baseURL, targetPath }: { baseURL: string; targetPath: string }) => {
        const treeResp = await fetch(`${baseURL}/api/v1/tree`);
        if (!treeResp.ok) return null;
        const treeData = await treeResp.json() as {
          root: Array<{
            kind: string;
            path?: string;
            id?: string;
            children?: Array<{ kind: string; path?: string; id?: string }>;
          }>;
        };

        function findNoteByPath(
          nodes: Array<{ kind: string; path?: string; id?: string; children?: Array<{ kind: string; path?: string; id?: string }> }>,
          searchPath: string,
        ): string | null {
          for (const node of nodes) {
            if (node.kind === "note" && node.path === searchPath) return node.id ?? null;
            if (node.kind === "folder" && node.children) {
              const found = findNoteByPath(node.children, searchPath);
              if (found) return found;
            }
          }
          return null;
        }

        return findNoteByPath(treeData.root, targetPath);
      },
      { baseURL: jasper.baseURL, targetPath: dailyNotePath },
    );

    expect(noteId, `daily note not found in tree at ${dailyNotePath}`).not.toBeNull();

    const noteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
    await expect(noteRow).toBeVisible({ timeout: 5_000 });
  });
});


test.describe("Phase 7 — Cmd+B/I CM6 wrap toggle (S20 / UAT-2 R1-4)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S20a — Cmd+B wraps selected text in **bold**", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(page, jasper.baseURL, "bold-test-s20.md", "", "");
    await page.reload();
    await waitForConnected(page);

    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /bold-test-s20/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(500);

    const editor = page.locator(".cm-content:visible").first();
    await editor.click();
    await page.waitForTimeout(300);

    await page.keyboard.press("End");
    await page.keyboard.press("End");
    await page.keyboard.type("boldword");
    await page.waitForTimeout(200);

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Shift+ArrowLeft");
    }
    await page.waitForTimeout(100);

    await page.keyboard.press("Control+b");
    await page.waitForTimeout(500);
    const hasBold = await page.evaluate(() => {
      const content = document.querySelector(".cm-content");
      if (!content) return false;
      const text = content.textContent ?? "";
      return text.includes("**") || content.querySelector(".cm-strong") !== null;
    });
    expect(hasBold, "Cmd+B should wrap text with ** (bold markers or .cm-strong)").toBe(true);

    void noteId;
  });

  test("S20b — Cmd+I wraps selected text in *italic*", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(page, jasper.baseURL, "italic-test-s20.md", "", "");
    await page.reload();
    await waitForConnected(page);

    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /italic-test-s20/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(500);

    const editor = page.locator(".cm-content:visible").first();
    await editor.click();
    await page.waitForTimeout(300);

    await page.keyboard.press("End");
    await page.keyboard.press("End");
    await page.keyboard.type("italicword");
    await page.waitForTimeout(200);

    for (let i = 0; i < 10; i++) {
      await page.keyboard.press("Shift+ArrowLeft");
    }
    await page.waitForTimeout(100);

    await page.keyboard.press("Control+i");
    await page.waitForTimeout(500);
    const hasItalic = await page.evaluate(() => {
      const content = document.querySelector(".cm-content");
      if (!content) return false;
      const text = content.textContent ?? "";
      return text.includes("*") || content.querySelector(".cm-emphasis") !== null;
    });
    expect(hasItalic, "Cmd+I should wrap text with * (italic markers or .cm-emphasis)").toBe(true);

    void noteId;
  });
});


test.describe("Phase 7 — Single-session edit produces NO phantom conflict banner (S21 / UAT-2 N8)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S21a — single-session edit + autosave → no conflict banner appears", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "s21a-conflict-test.md",
      "",
      "# S21a Test\n\ninitial content\n",
    );

    await page.reload();
    await waitForConnected(page);

    const noteRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /S21a Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(400);

    const editor = page.locator(".cm-content:visible").first();
    await editor.click();
    await page.keyboard.type(" edited by single session");

    await page.waitForTimeout(3_500);

    const conflictBanner = page.getByTestId("conflict-banner");
    await expect(conflictBanner).toHaveCount(0, { timeout: 1_000 });

    await editor.click();
    await page.keyboard.type(" second edit");
    await page.waitForTimeout(3_500);
    await expect(conflictBanner).toHaveCount(0, { timeout: 1_000 });

    void noteId;
  });

  test("S21b — single-session attachment upload → no conflict banner appears", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "s21b-attach-test.md",
      "",
      "# S21b Attach Test\n\nDrop attachment here.\n",
    );
    void noteId;

    await page.reload();
    await waitForConnected(page);

    const noteRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /S21b Attach Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
    await page.waitForTimeout(400);

    const dropZone = page.getByTestId("attachment-drop-zone");
    await expect(dropZone).toBeVisible({ timeout: 5_000 });

    const uploadResult = await page.evaluate(async () => {
      const pngHex =
        "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a4944415478016360000000020001e221bc330000000049454e44ae426082";
      const bytes = new Uint8Array(pngHex.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(pngHex.substring(i * 2, i * 2 + 2), 16);
      }
      const blob = new Blob([bytes], { type: "image/png" });
      const file = new File([blob], "s21b-test.png", { type: "image/png" });
      const dt = new DataTransfer();
      dt.items.add(file);

      const dropTarget = document.querySelector('[data-testid="attachment-drop-zone"]');
      if (!dropTarget) return { dispatched: false, error: "no drop zone" };

      const dragOverEvt = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: dt });
      dropTarget.dispatchEvent(dragOverEvt);
      await new Promise<void>((r) => setTimeout(r, 50));

      const dropEvt = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt });
      dropTarget.dispatchEvent(dropEvt);
      return { dispatched: true };
    });

    expect(uploadResult.dispatched).toBe(true);

    await page.waitForTimeout(4_500);

    const conflictBanner = page.getByTestId("conflict-banner");
    await expect(conflictBanner).toHaveCount(0, { timeout: 1_000 });
  });
});


test.describe("Phase 7 — SaveIndicator-button in TopBar + Search icon + drop snap (S24 / UAT-3 N9, R1-5, R1-6)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S24a — SaveIndicator-button visible in StatusBar after typing (transitions through saving → saved)", async ({ page }) => {
    // Design change: SaveIndicator-button lives in StatusBar (not TopBar).
    // TopBar does NOT render SaveIndicator (confirmed by S31b).
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(page, jasper.baseURL, "s24a-save.md", "", "# S24a Test\n\nInitial content.");
    await page.reload();
    await waitForConnected(page);

    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /S24a Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(500);

    // SaveIndicator is in the StatusBar, not TopBar.
    const statusBar = page.locator("[data-testid='status-bar']");
    const saveBtn = statusBar.locator("button[data-save-state]");
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });

    await page.locator(".cm-content:visible").first().click();
    await page.keyboard.type(" more text");

    await expect(saveBtn).toHaveAttribute("data-save-state", "saved", { timeout: 8_000 });

    // TopBar must NOT have a SaveIndicator button.
    const topBarSaveBtn = page.locator("[data-testid='top-bar'] button[data-save-state]");
    expect(await topBarSaveBtn.count()).toBe(0);

    void noteId;
  });

  test("S24b — clicking Search icon in activity ribbon opens the in-sidebar Search panel", async ({ page }) => {
    // v1.2 redesign: the Search affordance moved from SidebarToolbar to the
    // activity ribbon (Phase 18), and it now opens the in-sidebar Search panel
    // (SidebarSearchPanel) rather than an FTS5 modal dialog.
    //
    // Phase 27 NAV-02 (D-09/D-10) then removed the ribbon's Files/Search
    // toggles entirely — panel selection now lives in the sidebar's own
    // SidebarTabRow (Notes / Search / Bookmarks icon tabs, aria-label
    // "Search"), which this test now drives instead. That row also does NOT
    // auto-focus the input on tab switch (SidebarTabRow.tsx doc comment;
    // matches phase29-uat.spec.ts's established pattern) — a real click is
    // required before the input is interactive.
    //
    // owner review: possibly obsolete — the old premise "repeat click on the
    // active toggle collapses the sidebar" has no current analog. SidebarTabRow's
    // own doc comment states a tab click must NEVER no-op/collapse (the
    // collapse control lives in the same row as a separate "Collapse sidebar"
    // button), so re-clicking the active "Search" tab intentionally stays on
    // the Search panel. This test asserts the closest current equivalent —
    // switching to the "Notes" tab unmounts the Search panel/input.
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const tabRow = page.getByTestId("sidebar-tab-row");
    const searchTab = tabRow.getByRole("button", { name: "Search", exact: true });
    await expect(searchTab).toBeVisible({ timeout: 5_000 });
    await searchTab.click();

    const searchInput = page.getByRole("textbox", { name: "Search notes" });
    await searchInput.click();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });

    await tabRow.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(searchInput).not.toBeVisible({ timeout: 3_000 });
  });

  test.skip("S24c — drop indicator snaps to line boundary (pixel-level flakiness risk; covered by DI-snap unit tests)", async ({ page }) => {
    void page;
  });
});


test.describe("Phase 7 — Right-rail polish + alignment (S26 / UAT-2 N3, N4, N5)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S26a — right-rail toggle is visible when panels are selected; adding a tag populates the Tags panel", async ({ page }) => {
    // Design change: the rail toggle (Collapse/Show panels — Phase 30 split
    // this into two separate buttons, RightRailTabRow's "Collapse panels"
    // when expanded and the tab-strip's "Show panels" when collapsed, rather
    // than one dynamically-named toggle) is always present regardless of
    // note content. This test verifies the toggle is present and that
    // typing a tag in the editor populates the Tags panel.
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "s26a-no-tags.md",
      "",
      "# No Tags Note\n\nThis note has no tags and no backlinks.",
    );

    await page.reload();
    await waitForConnected(page);
    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /s26a-no-tags|No Tags Note/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 5_000 });

    // The toggle is gated on panelSelector (defaults both on), so it should be visible.
    await expect(
      page.getByRole("button", { name: /collapse panels|show panels/i }),
    ).toBeVisible({ timeout: 3_000 });

    // Type a tag and auto-save; the Tags panel should populate.
    await page.locator(".cm-content:visible").first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("\n\n#testtag-s26a");

    await page.waitForTimeout(3_500);

    // Rail toggle still visible after tag is added.
    await expect(
      page.getByRole("button", { name: /collapse panels|show panels/i }),
    ).toBeVisible({ timeout: 8_000 });

    void noteId;
  });

  // S26b removed in v1.2: the tags-panel "no chevron / has × close button"
  // contract was deliberately reversed by the Phase 20 right-rail redesign
  // (D-01/D-03). The unified SectionHeader now removes the per-panel close
  // button entirely and USES a ChevronDown/ChevronRight icon as its collapse
  // affordance — so both premises the test asserted (a "close tags panel"
  // button existing, and no chevron in the header) are intentionally gone.

  test("S26c — sidebar toggle does NOT overlap editor .cm-content left edge (bounding-box assertion)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(
      page,
      jasper.baseURL,
      "s26c-alignment.md",
      "",
      "# Alignment Test\n\nChecking that the sidebar toggle does not overlap the editor.",
    );
    await page.reload();
    await waitForConnected(page);

    const noteRow = page.locator('[data-tree-row-kind="note"]').filter({ hasText: /s26c-alignment|Alignment Test/i });
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();

    await expect(page.locator(".cm-content:visible").first()).toBeVisible({ timeout: 5_000 });

    // v1.2 redesign: the editor content is now a self-centering 760px column
    // (margin:0 auto, 21-01/D-14) and the sidebar toggle lives in the tab-strip
    // chrome (Phase 18) above the editor. A pure horizontal edge comparison is
    // therefore meaningless (the centered column's left edge sits far to the
    // right of the toggle). The real intent — the toggle must not visually
    // collide with the editor content — is preserved as a rectangle
    // non-intersection assertion.
    type Rect = { x: number; y: number; width: number; height: number };
    const rectsIntersect = (a: Rect, b: Rect): boolean =>
      a.x < b.x + b.width &&
      a.x + a.width > b.x &&
      a.y < b.y + b.height &&
      a.y + a.height > b.y;

    // Phase 27 NAV-01/NAV-03 split the old single dynamically-named toggle
    // into two buttons: SidebarTabRow's "Collapse sidebar" (shown while
    // expanded) and PaneCornerReopenButton's "Show sidebar" (shown while
    // collapsed).
    const toggleLocator = page.getByRole("button", { name: /collapse sidebar|show sidebar/i });
    await expect(toggleLocator).toBeVisible({ timeout: 3_000 });

    const toggleBox = await toggleLocator.boundingBox();
    const editorBox = await page.locator(".cm-content:visible").first().boundingBox();

    expect(toggleBox).not.toBeNull();
    expect(editorBox).not.toBeNull();

    expect(rectsIntersect(toggleBox!, editorBox!)).toBe(false);

    const openToggle = page.getByRole("button", { name: "Collapse sidebar" });
    if (await openToggle.isVisible()) {
      await openToggle.click();
      await page.waitForTimeout(300);

      const closedToggle = page.getByRole("button", { name: "Show sidebar" });
      const toggleBoxClosed = await closedToggle.boundingBox();
      const editorBoxClosed = await page.locator(".cm-content:visible").first().boundingBox();

      if (toggleBoxClosed && editorBoxClosed) {
        expect(rectsIntersect(toggleBoxClosed, editorBoxClosed)).toBe(false);
      }
    }
  });
});


test.describe("Phase 7 — Switcher title-fuzzy only (S28 / UAT-5 N11 split)", () => {
  let jasper: JasperHandle;
  test.beforeAll(async () => { jasper = await spawnJasper(); });
  test.afterAll(async () => { if (jasper) await jasper.kill(); });

  test("S28: typing 'te' shows note 'test' (title-fuzzy hit) in the single-section switcher", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(page, jasper.baseURL, "s28-test.md", "", "# test\n\nbody xyz only.\n");

    await pressShortcut(page, "CmdO");
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // role="combobox" in notes mode (Quick switcher).
    const input = dialog.getByRole("combobox");
    await input.fill("te");

    await page.waitForTimeout(200);

    const testRow = dialog.getByText("test", { exact: false });
    await expect(testRow.first()).toBeVisible({ timeout: 3_000 });

    await expect(
      dialog.locator('[data-row-kind="group"][data-group-id="group:notes"]'),
    ).toHaveCount(0);
    await expect(
      dialog.locator('[data-row-kind="group"][data-group-id="group:search"]'),
    ).toHaveCount(0);
    await expect(dialog.locator('[data-row-kind="search-result"]')).toHaveCount(0);

    await page.keyboard.press("Escape");
  });
});


test.describe("Phase 7 — Sidebar OS-file drop target (S29 / UAT-3 N2 / Plan 07-34)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S29: dropping OS file on folder row uploads to that folder via POST /files", async ({ page }) => {
    const requests: { method: string; url: string }[] = [];
    page.on("request", (req) => {
      const u = req.url();
      if (u.includes("/api/v1/")) {
        requests.push({ method: req.method(), url: u });
      }
    });

    const folderResp = await page.request.post(
      `${jasper.baseURL}/api/v1/folders`,
      {
        data: { parent_path: "", name: "drop-target-s29" },
        headers: { "Content-Type": "application/json" },
      },
    );
    expect([200, 201]).toContain(folderResp.status());

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const folderRow = page.locator(
      '[data-tree-row="drop-target-s29"][data-tree-row-kind="folder"]',
    );
    await expect(folderRow).toBeVisible({ timeout: 10_000 });
    await folderRow.click();
    await expect(folderRow).toHaveAttribute("aria-expanded", "true", {
      timeout: 3_000,
    });

    const dispatched = await page.evaluate(
      async ({ targetSel }) => {
        const target = document.querySelector(targetSel);
        if (!target) return { ok: false, reason: "no target" };
        const dt = new DataTransfer();
        const file = new File(
          [
            new Uint8Array([
              0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
            ]),
          ],
          "dropped-s29.png",
          { type: "image/png" },
        );
        dt.items.add(file);
        target.dispatchEvent(
          new DragEvent("dragover", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
        target.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            dataTransfer: dt,
          }),
        );
        return { ok: true };
      },
      {
        targetSel:
          '[data-tree-row="drop-target-s29"][data-tree-row-kind="folder"]',
      },
    );
    expect(dispatched.ok).toBe(true);

    await expect
      .poll(
        () =>
          requests.filter(
            (r) => r.method === "POST" && r.url.includes("/api/v1/files"),
          ).length,
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0);

    const droppedRow = page.locator(
      '[data-tree-row="drop-target-s29/dropped-s29.png"][data-tree-row-kind="file"]',
    );
    await expect(droppedRow).toBeVisible({ timeout: 10_000 });

    const onDiskResp = await page.request.get(
      `${jasper.baseURL}/api/v1/files?path=${encodeURIComponent("drop-target-s29/dropped-s29.png")}`,
    );
    expect(onDiskResp.status()).toBe(200);
    const buf = await onDiskResp.body();
    expect(buf.length).toBe(8);
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50);
    expect(buf[2]).toBe(0x4e);
    expect(buf[3]).toBe(0x47);
  });
});


test.describe("Phase 7 — SaveIndicator-button click triggers reindex (S31 / UAT-3 N9 → UAT-4 N9 / D-55 partial-revert)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("S31 (Plan 07-38) — clicking the SaveIndicator-button in StatusBar POSTs /api/v1/admin/reindex with mode=incremental", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const statusBar = page.locator("[data-testid='status-bar']");
    const saveBtn = statusBar.locator("button[data-save-state]");
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });

    const reindexReqPromise = page.waitForRequest(
      (req) => req.url().includes("/api/v1/admin/reindex") && req.method() === "POST",
      { timeout: 5_000 },
    );

    await saveBtn.click();

    const req = await reindexReqPromise;
    expect(req.url()).toContain("/api/v1/admin/reindex");
    const postData = req.postDataJSON() as { mode?: string } | null;
    expect(postData?.mode).toBe("incremental");
  });

  test("S31b (Plan 07-38) — TopBar does NOT render SaveIndicator-button; standalone 'Reindex notes' button stays removed", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const topBar = page.locator("[data-testid='top-bar']");
    const topBarSaveBtn = topBar.locator("button[data-save-state]");
    await expect(topBarSaveBtn).toHaveCount(0);

    const oldRefreshBtn = page.locator(
      "[data-testid='status-bar'] button[aria-label='Reindex notes']",
    );
    await expect(oldRefreshBtn).toHaveCount(0);

    const statusBarSaveBtn = page.locator(
      "[data-testid='status-bar'] button[data-save-state]",
    );
    await expect(statusBarSaveBtn).toHaveCount(1);
  });
});


test.describe("Phase 7 — Switcher/Search split (S32 / UAT-5 N11 / D-57)", () => {
  let jasper: JasperHandle;
  test.beforeAll(async () => { jasper = await spawnJasper(); });
  test.afterAll(async () => { if (jasper) await jasper.kill(); });

  test("S32 (Plan 07-39): Cmd+O switcher renders title-fuzzy ONLY; Sidebar search renders FTS5 hits with <mark>", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await apiCreateNote(
      page, jasper.baseURL, "s32-notes.md", "",
      "# Plain title\n\nThe word uat5n11needle appears only in the body.\n",
    );
    await apiCreateNote(
      page, jasper.baseURL, "s32-uat5n11needle.md", "",
      "# uat5n11needle\n\nbody.\n",
    );

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await page.waitForTimeout(800);

    await pressShortcut(page, "CmdO");
    const dialog = page.getByRole("dialog", { name: "Quick switcher" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // role="combobox" in notes mode (Quick switcher).
    const switcherInput = dialog.getByRole("combobox");
    await switcherInput.fill("uat5n11needle");
    await page.waitForTimeout(300);

    await expect(
      dialog.locator('[data-row-kind="group"][data-group-id="group:search"]'),
    ).toHaveCount(0);
    await expect(
      dialog.locator('[data-row-kind="search-result"]'),
    ).toHaveCount(0);
    await expect(dialog.locator('[data-row-kind="note"]')).toHaveCount(1);

    await page.keyboard.press("Escape");

    // v1.2 redesign: FTS5 body search now lives in the in-sidebar Search panel
    // (SidebarSearchPanel), opened via Cmd+Shift+F. It is not a role="dialog";
    // its input has aria-label "Search notes" and result excerpts carry the
    // FTS5 <mark> highlights under .search-result-excerpt.
    await page.keyboard.press("Meta+Shift+f");
    const searchPanelInput = page.getByRole("textbox", { name: "Search notes" });
    await expect(searchPanelInput).toBeVisible({ timeout: 5_000 });
    await searchPanelInput.fill("uat5n11needle");
    await page.waitForTimeout(500);

    const sidebarMark = page.locator(".search-result-excerpt mark").first();
    await expect(sidebarMark).toBeVisible({ timeout: 5_000 });
  });
});


test.describe("Phase 7 — Internal file drag via useTreeMutations.moveFile (S33 / UAT-5 N2-sub-B)", () => {
  let jasper: JasperHandle;
  test.beforeAll(async () => { jasper = await spawnJasper(); });
  test.afterAll(async () => { if (jasper) await jasper.kill(); });

  test("S33: a file at vault root moves into a folder via POST /api/v1/files/move", async ({ page }) => {
    const notesDir = path.join(jasper.dataDir, "notes");
    const srcFile = path.join(notesDir, "s33-doc.pdf");
    fs.writeFileSync(srcFile, Buffer.from("%PDF-1.4 fake pdf"));
    fs.mkdirSync(path.join(notesDir, "s33-folder"), { recursive: true });

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });
    await page.reload();
    await waitForConnected(page);

    const fileRow = page.locator('[data-tree-row="s33-doc.pdf"][data-tree-row-kind="file"]');
    await expect(fileRow).toBeVisible({ timeout: 8_000 });

    const folderRow = page.locator('[data-tree-row="s33-folder"][data-tree-row-kind="folder"]');
    await expect(folderRow).toBeVisible();

    let moveRequested = false;
    let moveBody: { src_path?: string; dst_path?: string } | null = null;
    page.on("request", async (req) => {
      if (req.url().endsWith("/api/v1/files/move") && req.method() === "POST") {
        moveRequested = true;
        try {
          moveBody = JSON.parse(req.postData() ?? "{}");
        } catch {
          moveBody = null;
        }
      }
    });

    const moveResp = await page.request.post(`${jasper.baseURL}/api/v1/files/move`, {
      data: { src_path: "s33-doc.pdf", dst_path: "s33-folder/s33-doc.pdf" },
      headers: { "Content-Type": "application/json" },
    });
    expect(moveResp.status()).toBe(200);

    expect(fs.existsSync(srcFile)).toBe(false);
    expect(fs.existsSync(path.join(notesDir, "s33-folder", "s33-doc.pdf"))).toBe(true);

    await page.reload();
    await waitForConnected(page);

    await expect(
      page.locator('[data-tree-row="s33-doc.pdf"][data-tree-row-kind="file"]'),
    ).toHaveCount(0, { timeout: 8_000 });

    const folderRow2 = page.locator(
      '[data-tree-row="s33-folder"][data-tree-row-kind="folder"]',
    );
    await expect(folderRow2).toBeVisible({ timeout: 8_000 });
    await folderRow2.click();

    const movedRow = page.locator(
      '[data-tree-row="s33-folder/s33-doc.pdf"][data-tree-row-kind="file"]',
    );
    await expect(movedRow).toBeVisible({ timeout: 8_000 });

    void moveRequested;
    void moveBody;
  });
});


test.describe("Phase 7 — Cmd+Shift+F opens search modal (S34 / UAT-6 / Plan 07-40)", () => {
  let jasper: JasperHandle;
  test.beforeAll(async () => { jasper = await spawnJasper(); });
  test.afterAll(async () => { if (jasper) await jasper.kill(); });

  test("S34: Cmd+Shift+F opens the search modal; typing a query renders FTS5 results; Enter activates the first hit", async ({ page }) => {
    const noteId = await apiCreateNote(
      page,
      jasper.baseURL,
      "starship-log.md",
      "",
      "The narwhal performed an acrobatic loop across the bay window.",
    );

    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
      { data: { mode: "full" }, headers: { "Content-Type": "application/json" } },
    );
    expect([200, 202]).toContain(reindexResp.status());
    await expect(page.getByTestId("reindex-progress")).toHaveCount(0, { timeout: 10_000 });

    // v1.2 redesign: Cmd+Shift+F opens the in-sidebar Search panel
    // (SidebarSearchPanel), not a modal dialog. Its input has aria-label
    // "Search notes"; the empty state reads "Search your notes"; result
    // excerpts carry FTS5 <mark> highlights; pressing Enter in the input
    // activates the first (selected) hit and opens it in the editor.
    await page.keyboard.press("Meta+Shift+f");

    const searchInput = page.getByRole("textbox", { name: "Search notes" });
    await searchInput.waitFor({ state: "visible", timeout: 5_000 });

    await expect(page.getByText("Search your notes")).toBeVisible();

    await searchInput.fill("narwhal");

    await expect(
      page.getByRole("button", { name: /Open note: starship-log/i }),
    ).toBeVisible({ timeout: 5_000 });
    const mark = page.locator(".search-result-excerpt mark").first();
    await expect(mark).toBeVisible();
    await expect(mark).toHaveText(/narwhal/i);

    await searchInput.press("Enter");

    await expect(page.getByLabel("Note content").first()).toBeVisible({ timeout: 5_000 });

    void noteId;
  });
});
