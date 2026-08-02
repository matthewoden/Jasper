/**
 * (SET3-01/02/04/06/07): proves every phase-32 success
 * criterion end-to-end against the real embedded binary, one test per
 * criterion. Each test spawns its OWN `spawnJasper()` instance against an
 * ephemeral vault + port (per-test isolation — the "config leniency" test
 * stops and restarts its instance, which would corrupt a shared instance).
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — this spec runs against the EMBEDDED binary,
 * not the Vite dev server.
 *
 * Discipline: zero fixed-duration waits. Every timing-sensitive assertion
 * uses Playwright's own auto-retrying `expect()`/`toPass()` polling (memory
 * no-flaky-tests) — never a fixed-timeout wait. Drag interactions use real
 * `page.mouse` movement (memory verify-dnd-with-real-mouse), never
 * synthetic events.
 *
 * Two behaviors this spec deliberately does NOT assert, because they are
 * genuinely un-automatable and are routed to plan 32-11's human-verify
 * checkpoint instead (see ResetConfirmDialog.tsx's own header comment and
 *'s "Known Boundary" section):
 *   (a) Nested AlertDialog focus-trap return-to-trigger + Escape-key
 *       scoping when opened inside the already-open Settings Dialog —
 *       jsdom/Playwright's own DOM has no assertable focus-trap semantics
 *       distinct from "an element received focus".
 *   (b) TypePreviewPanel's OWN paragraph restyling live, mid-drag. Per
 *       AppearanceSection.tsx, the panel's fontSize/lineHeight props are
 *       React state set only inside SliderNumberPair's `onCommit` (fires on
 *       pointer-up/key-up) — NOT on every drag step. What genuinely
 *       restyles live, on every drag step, is `document.documentElement`'s
 *       `--editor-font-size`/`--editor-line-height` CSS custom properties
 *       (SliderNumberPair's `handleRangeChange`), which the real CodeMirror
 *       editor behind the dialog reads via `var(--editor-font-size)`
 *       (themeBridge.ts). This spec's "type preview" test therefore proves
 *       the REAL editor's live restyle during the drag — the automatable
 *       half of SET3-07 — and leaves the preview-panel's rendered-typography
 *       "feel" to the human checkpoint.
 */
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { apiCreateNote, waitForConnected } from "./helpers/phase7Helpers";

async function apiCreateFolder(
  page: Page,
  baseURL: string,
  name: string,
  parentPath = "",
): Promise<void> {
  const resp = await page.request.post(`${baseURL}/api/v1/folders`, {
    data: { parent_path: parentPath, name },
  });
  if (resp.status() !== 201) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(`apiCreateFolder ${name}: ${String(resp.status())} ${body}`);
  }
}

/**
 * Spawns a throwaway Jasper instance purely to read its `GET /config` —
 * i.e. the Go `config.Defaults()` value for an untouched vault — then kills
 * it. This is the ONLY place this spec compares a value against "default":
 * a live value from a fresh boot, never a literal copied from
 * `DEFAULT_CONFIG`/`defaults.go` (frontend/Go defaults
 * drift risk).
 */
async function getFreshDefaultConfig(
  page: Page,
): Promise<{ editor: { autosaveMs: number; fontSize: number } }> {
  const fresh = await spawnJasper();
  try {
    const resp = await page.request.get(`${fresh.baseURL}/api/v1/config`);
    if (resp.status() !== 200) {
      throw new Error(`getFreshDefaultConfig: GET /config returned ${String(resp.status())}`);
    }
    return await resp.json();
  } finally {
    await fresh.kill();
  }
}

test.describe("@phase32 SET3-01/02/04/06/07: sectioned Settings dialog E2E", () => {
  let jasper: JasperHandle | undefined;

  test.afterEach(async () => {
    if (jasper) {
      await jasper.kill();
      jasper = undefined;
    }
  });

  test("nav: four sections, no Templates or Server, fixed geometry across a switch, reopen lands on Appearance (SET3-01)", async ({
    page,
  }) => {
    jasper = await spawnJasper();
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    const navButtons = dialog.locator("nav button");
    await expect(navButtons).toHaveCount(4);
    const labels = (await navButtons.allTextContents()).map((l) => l.trim());
    expect(labels).toEqual(["Appearance", "Editor", "Daily notes", "About"]);
    expect(labels.some((l) => /templates/i.test(l))).toBe(false);
    expect(labels.some((l) => /server/i.test(l))).toBe(false);

    // Settings always opens on Appearance.
    await expect(
      dialog.getByRole("button", { name: "Appearance", exact: true }),
    ).toHaveAttribute("aria-current", "page");

    const boxBefore = await dialog.boundingBox();
    if (!boxBefore) throw new Error("Settings dialog has no bounding box");

    await dialog.getByRole("button", { name: "Daily notes" }).click();
    // Barrier: wait for a control in the arrived pane to be visible so the
    // second measurement below is taken after the pane has actually
    // rendered, not mid-switch. The template textbox is the only remaining
    // control in this pane (the folder input was removed in plan 32.1-08) —
    // its purpose here is purely "the pane has finished switching."
    await expect(dialog.getByRole("textbox", { name: "Daily note template" })).toBeVisible();

    const boxAfter = await dialog.boundingBox();
    if (!boxAfter) throw new Error("Settings dialog has no bounding box after switching panes");
    expect(boxAfter).toEqual(boxBefore);

    await dialog.getByRole("button", { name: "Close settings" }).click();
    await expect(dialog).not.toBeVisible();

    await page.getByTestId("settings-menu-trigger").click();
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("button", { name: "Appearance", exact: true }),
    ).toHaveAttribute("aria-current", "page");
  });

  test("reset: Editor Reset behind a confirm; only editor.autosaveMs changes; matches a live GET /config default (SET3-02)", async ({
    page,
  }) => {
    jasper = await spawnJasper();
    const baseURL = jasper.baseURL;
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(baseURL);
    await waitForConnected(page);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Reset scoping: change the Daily notes template FIRST, then prove the
    // Editor Reset below never touches it. Daily notes is a stronger scoping
    // vehicle than the retired Server bind field it replaces (ADR-002,
    // 2026-07-26) — Daily notes IS a section with its own Reset, so an
    // over-broad Editor Reset has a live target it could wrongly clobber.
    await dialog.getByRole("button", { name: "Daily notes" }).click();
    const templateInput = dialog.getByRole("textbox", { name: "Daily note template" });
    const scopingProbe = "## {{date}}\n\nscoping probe\n";
    await templateInput.fill(scopingProbe);
    await templateInput.blur();
    await expect(templateInput).toHaveValue(scopingProbe);

    // The blur above fires PATCH /config, but toHaveValue only proves the
    // input's own local state -- without this poll, the template write races
    // the Editor Reset below. Polling AFTER the reset instead would pass
    // even if the template PATCH landed late, which would silently destroy
    // the reset-scoping proof this test exists to provide.
    await expect.poll(
      async () => {
        try {
          const resp = await page.request.get(`${baseURL}/api/v1/config`);
          if (!resp.ok()) return null;
          const body = (await resp.json()) as { dailyNotes?: { template?: string } };
          return body.dailyNotes?.template ?? null;
        } catch {
          return null;
        }
      },
      { timeout: 5000, message: "waiting for dailyNotes.template PATCH to land server-side" },
    ).toBe(scopingProbe);

    await dialog.getByRole("button", { name: "Editor", exact: true }).click();
    const autosaveInput = dialog.getByRole("spinbutton", { name: "Autosave interval" });
    const nonDefaultAutosaveMs = "4500";
    await autosaveInput.fill(nonDefaultAutosaveMs);
    await autosaveInput.blur();
    await expect(autosaveInput).toHaveValue(nonDefaultAutosaveMs);

    // Reset behind a confirm: open, read the locked title, Cancel first.
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    const confirmDialog = page.getByRole("alertdialog");
    await expect(confirmDialog).toBeVisible();
    await expect(confirmDialog.getByText("Reset Editor to defaults?")).toBeVisible();

    await confirmDialog.getByRole("button", { name: "Cancel" }).click();
    await expect(confirmDialog).not.toBeVisible();
    await expect(autosaveInput).toHaveValue(nonDefaultAutosaveMs);

    // Reopen and actually confirm.
    await dialog.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(confirmDialog).toBeVisible();
    await confirmDialog.getByRole("button", { name: "Reset", exact: true }).click();
    await expect(confirmDialog).not.toBeVisible();

    // The only cross-instance comparison in this spec: a freshly spawned
    // vault's own GET /config is the ground truth for "default", never a
    // literal copied from DEFAULT_CONFIG/defaults.go.
    const defaults = await getFreshDefaultConfig(page);
    await expect(autosaveInput).toHaveValue(String(defaults.editor.autosaveMs));

    const cfgResp = await page.request.get(`${baseURL}/api/v1/config`);
    const cfg = await cfgResp.json();
    expect(cfg.editor.autosaveMs).toBe(defaults.editor.autosaveMs);

    // Reset scoping: the Daily notes template set before the Editor Reset
    // must survive untouched — both in the UI and, more strongly, in the
    // already-fetched server-side config (server-side proof, matching how
    // cfg.editor.autosaveMs is checked above).
    await dialog.getByRole("button", { name: "Daily notes" }).click();
    await expect(templateInput).toHaveValue(scopingProbe);
    expect(cfg.dailyNotes.template).toBe(scopingProbe);
  });

  test("about: all six vault facts render with real seeded values; copy matches the displayed path (SET3-04)", async ({
    page,
    context,
  }) => {
    jasper = await spawnJasper();
    const baseURL = jasper.baseURL;
    await page.setViewportSize({ width: 1512, height: 944 });

    // Navigate + connect BEFORE seeding (matches every other passing spec in
    // this codebase, e.g. phase15-uat's spawnIsolated/waitForConnected
    // pattern) — creating notes before the app has ever loaded races the
    // server's own async boot finalization (scratchpad seed + frontmatter
    // migration) and can spuriously 409.
    await page.goto(baseURL);
    await waitForConnected(page);

    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: baseURL });

    // Baseline BEFORE seeding — a fresh vault already carries one seeded
    // scratchpad note, so the seeded-count assertion below must add
    // to this baseline rather than assume a pristine zero.
    const baselineResp = await page.request.get(`${baseURL}/api/v1/vault/about`);
    const baseline = await baselineResp.json();

    // Seed a known note/folder shape in a nested folder BEFORE opening About.
    await apiCreateFolder(page, baseURL, "projects", "");
    await apiCreateFolder(page, baseURL, "archive", "projects");
    await apiCreateNote(page, baseURL, "root-note.md", "", "# Root\n");
    await apiCreateNote(page, baseURL, "proj-note.md", "projects", "# Proj\n");
    await apiCreateNote(page, baseURL, "archived-note.md", "projects/archive", "# Archived\n");

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "About", exact: true }).click();

    // Ground truth from the server itself (server-assembled facts) —
    // self-checked against the seeded shape, then asserted against the UI.
    const aboutResp = await page.request.get(`${baseURL}/api/v1/vault/about`);
    expect(aboutResp.status()).toBe(200);
    const about = await aboutResp.json();
    expect(about.noteCount).toBe(baseline.noteCount + 3);
    expect(about.folderCount).toBe(baseline.folderCount + 2);
    expect(about.appVersion.length).toBeGreaterThan(0);
    // The server canonicalizes the vault path (NFC + lowercase + symlink
    // resolution on darwin, per vault.Canonicalize) before ever storing it,
    // so `about.path` legitimately differs in case/prefix from the raw
    // mkdtemp string — compare against the resolved, lowercased form.
    expect(about.path.toLowerCase()).toBe(realpathSync(jasper.dataDir).toLowerCase());

    const vaultName = path.basename(about.path);
    await expect(dialog.getByText(vaultName, { exact: true })).toBeVisible({ timeout: 10_000 });
    await expect(dialog.getByText(String(about.noteCount), { exact: true })).toBeVisible();
    await expect(dialog.getByText(String(about.folderCount), { exact: true })).toBeVisible();
    await expect(dialog.getByText(about.path, { exact: true })).toBeVisible();
    await expect(dialog.getByText(about.appVersion, { exact: true })).toBeVisible();
    await expect(
      dialog.getByText(new RegExp(`Port ${about.mcpPort} · ${about.mcpGrantCount} writable path`)),
    ).toBeVisible();

    await dialog.getByRole("button", { name: "Copy vault path" }).click();
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(about.path);
  });

  test("config leniency: a hand-edited config.json with a bad field survives a UI save round-trip (SET3-06)", async ({
    page,
  }) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "jasper-e2e-leniency-"));
    const nonDefaultAutosaveMs = 4750;
    try {
      let handle = await spawnJasper({ dataDir });
      jasper = handle;

      // Force config.json to actually exist on disk (with the real
      // port/dataDir already resolved) before hand-editing it — a fresh
      // vault has no config.json until the first PUT.
      const getResp = await page.request.get(`${handle.baseURL}/api/v1/config`);
      const liveConfig = await getResp.json();
      const putResp = await page.request.put(`${handle.baseURL}/api/v1/config`, { data: liveConfig });
      expect(putResp.status()).toBe(200);

      await new Promise<void>((resolve) => {
        handle.proc.once("exit", () => resolve());
        handle.proc.kill("SIGTERM");
      });

      const cfgPath = path.join(dataDir, ".jasper", "config.json");
      const onDisk = JSON.parse(await readFile(cfgPath, "utf-8"));
      onDisk.editor.fontSize = "not-a-number"; // wrong-typed known field
      onDisk.editor.autosaveMs = nonDefaultAutosaveMs; // well-typed, non-default sibling
      onDisk.aTotallyUnrecognizedTopLevelField = { nested: true }; // unrecognized key
      await writeFile(cfgPath, JSON.stringify(onDisk));

      handle = await spawnJasper({ dataDir });
      jasper = handle;

      await page.setViewportSize({ width: 1512, height: 944 });
      await page.goto(handle.baseURL);
      await waitForConnected(page);

      await page.getByTestId("settings-menu-trigger").click();
      const dialog = page.getByRole("dialog", { name: "Settings" });
      await expect(dialog).toBeVisible();

      await dialog.getByRole("button", { name: "Editor", exact: true }).click();
      const autosaveInput = dialog.getByRole("spinbutton", { name: "Autosave interval" });
      await expect(autosaveInput).toHaveValue(String(nonDefaultAutosaveMs));

      await dialog.getByRole("button", { name: "Appearance", exact: true }).click();
      const fontSizeInput = dialog.getByRole("spinbutton", { name: "Font size" });
      const defaults = await getFreshDefaultConfig(page);
      await expect(fontSizeInput).toHaveValue(String(defaults.editor.fontSize));

      // Change a setting through the UI; the preserved sibling value must
      // survive the round trip.
      await dialog.getByRole("button", { name: "Sky", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Sky", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );

      const cfgResp = await page.request.get(`${handle.baseURL}/api/v1/config`);
      const cfg = await cfgResp.json();
      expect(cfg.editor.autosaveMs).toBe(nonDefaultAutosaveMs);
    } finally {
      if (jasper) {
        await jasper.kill();
        jasper = undefined;
      }
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("appearance: every row carries its helper caption and the two typography sliders measure equal width (G-01, G-02)", async ({
    page,
  }) => {
    jasper = await spawnJasper();
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Settings always opens on Appearance — no nav click needed.
    await expect(
      dialog.getByText("Used for links, tags, highlights and selection", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Typeface for note body text", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Body text size in the editor · 8–32px", { exact: true }),
    ).toBeVisible();
    await expect(
      dialog.getByText("Vertical rhythm of paragraphs and lists · 1.0–3.0", { exact: true }),
    ).toBeVisible();

    // Direct guard on the cause, not just the symptom: the slider-parity
    // assertion below only catches a widened label column indirectly. G-02
    // fixed the column at 160px, so assert that literally (32-REVIEW).
    const labelColumn = dialog
      .getByText("Body text size in the editor · 8–32px", { exact: true })
      .locator("..");
    await expect(async () => {
      const box = await labelColumn.boundingBox();
      if (!box) throw new Error("Font size label column has no bounding box");
      expect(box.width).toBeCloseTo(160, 0);
    }).toPass({ timeout: 3_000 });

    const fontSizeSlider = dialog.getByRole("slider", { name: "Font size" });
    const lineHeightSlider = dialog.getByRole("slider", { name: "Line height" });
    await expect(fontSizeSlider).toBeVisible();
    await expect(lineHeightSlider).toBeVisible();

    await expect(async () => {
      const fontSizeBox = await fontSizeSlider.boundingBox();
      const lineHeightBox = await lineHeightSlider.boundingBox();
      if (!fontSizeBox || !lineHeightBox) {
        throw new Error("Font size or Line height slider has no bounding box");
      }
      expect(Math.abs(fontSizeBox.width - lineHeightBox.width)).toBeLessThanOrEqual(0.5);
    }).toPass({ timeout: 3_000 });
  });

  test("type preview: real-mouse font-size drag restyles the live editor before mouse-up, commits exactly once (SET3-07)", async ({
    page,
  }) => {
    jasper = await spawnJasper();
    const baseURL = jasper.baseURL;
    await page.setViewportSize({ width: 1512, height: 944 });

    // Navigate + connect BEFORE seeding (see the "about" test's comment) —
    // creating a note before the app has ever loaded races the server's own
    // async boot finalization and can spuriously 409.
    await page.goto(baseURL);
    await waitForConnected(page);

    // apiCreateNote's PUT sets the H1, which becomes the note's searchable
    // title server-side immediately — but the client's quick-switcher tree
    // cache only refreshes on note:created/moved/folder events, NOT on
    // note:updated (the H1-driven rename path only fires through an open
    // editor's own save cycle, which this API-only seed never exercises).
    // Reloading after seeding forces a fresh GET /tree strictly after the
    // PUT above has already landed, so the switcher search deterministically
    // sees the current title instead of racing the WS note:created broadcast
    // against apiCreateNote's own PUT.
    const noteTitle = "type-preview-note";
    const displayTitle = "Type preview";
    await apiCreateNote(page, baseURL, `${noteTitle}.md`, "", `# ${displayTitle}\n\nSample body text.\n`);
    await page.reload();
    await waitForConnected(page);

    await page.keyboard.press("Meta+o");
    const switcher = page.getByRole("dialog", { name: "Quick switcher" });
    await switcher.waitFor({ state: "visible", timeout: 5_000 });
    await switcher.getByRole("combobox").fill(displayTitle);
    // Wait for the REAL note row specifically (data-row-kind="note", per
    // CommandMenu.tsx), not the "create new" fallback row
    // (data-row-kind="create", rendered as `Create "Type preview"`) —
    // a substring/exact text wait can still resolve against the create row
    // before the API-created note's WS broadcast reaches the client's
    // search index, causing Enter to hit the create-fallback and 409.
    const noteRow = switcher.locator('[data-row-kind="note"]', { hasText: displayTitle });
    await expect(noteRow).toBeVisible({ timeout: 5_000 });
    // Confirm it is also the SELECTED row (index 0) before Enter activates
    // it — a real match sorts ahead of the create-fallback row, but assert
    // rather than assume.
    await expect(noteRow).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(switcher).not.toBeVisible();

    const cmEditor = page.locator(".cm-editor").first();
    await expect(cmEditor).toBeVisible({ timeout: 10_000 });
    const fontSizeBefore = await cmEditor.evaluate((el) => getComputedStyle(el).fontSize);

    // .cm-editor is the element the value already reached even when the
    // bug shipped (the propagation break was one level deeper, on
    // .cm-scroller) — measuring a rendered prose line too proves the value
    // reaches actual note text, not only the outer wrapper. Selected by
    // text, not index: the first .cm-line carries cm-heading-1.
    const proseLine = page.locator(".cm-line", { hasText: "Sample body text." });
    await expect(proseLine).toHaveCount(1);
    const proseFontSizeBefore = await proseLine.evaluate((el) => getComputedStyle(el).fontSize);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    // Settings always opens on Appearance — the font-size slider is
    // already the active pane; no extra nav click needed.

    const previewFontSizeBefore = await dialog
      .getByText(/Type styling applies instantly/)
      .evaluate((el) => getComputedStyle(el).fontSize);

    const slider = dialog.getByRole("slider", { name: "Font size" });
    const box = await slider.boundingBox();
    if (!box) throw new Error("Font size slider has no bounding box");

    // PATCH, not PUT: the slider commit path moved onto saveConfig(patch) in
    //. A PUT from this control would itself be a regression.
    const configWriteRequests: string[] = [];
    page.on("request", (req) => {
      if (req.method() === "PATCH" && req.url().includes("/api/v1/config")) {
        configWriteRequests.push(req.url());
      }
    });

    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, y, { steps: 12 });

    // The real editor behind the dialog restyles live via the CSS custom
    // property (SliderNumberPair's handleRangeChange), DURING the drag —
    // asserted here before mouse-up, so this cannot be satisfied by the
    // eventual onCommit alone.
    await expect(async () => {
      const fontSizeDuring = await cmEditor.evaluate((el) => getComputedStyle(el).fontSize);
      expect(fontSizeDuring).not.toBe(fontSizeBefore);
      const proseFontSizeDuring = await proseLine.evaluate((el) => getComputedStyle(el).fontSize);
      expect(proseFontSizeDuring).not.toBe(proseFontSizeBefore);
    }).toPass({ timeout: 3_000 });

    // The in-dialog preview card must move mid-drag too. It previously took
    // commit-driven React state, so it only updated on pointer-up — which
    // defeats the card's stated purpose. Asserted BEFORE mouse-up.
    const previewPara = dialog.getByText(/Type styling applies instantly/);
    await expect(async () => {
      const previewDuring = await previewPara.evaluate((el) => getComputedStyle(el).fontSize);
      expect(previewDuring).not.toBe(previewFontSizeBefore);
    }).toPass({ timeout: 3_000 });

    await page.mouse.up();

    // "Exactly one write fired" only proves the request was SENT — poll the
    // persisted config until it reflects the commit (the request event
    // fires before the response lands, so asserting the count alone risks
    // reading GET /config before the write has completed).
    await expect(async () => {
      expect(configWriteRequests.length).toBe(1);
      const cfgResp = await page.request.get(`${baseURL}/api/v1/config`);
      const cfg = await cfgResp.json();
      const fontSizeAfter = await cmEditor.evaluate((el) => getComputedStyle(el).fontSize);
      expect(fontSizeAfter).toBe(`${String(cfg.editor.fontSize)}px`);
      const proseFontSizeAfter = await proseLine.evaluate((el) => getComputedStyle(el).fontSize);
      expect(proseFontSizeAfter).toBe(`${String(cfg.editor.fontSize)}px`);
    }).toPass({ timeout: 3_000 });
  });

  test("line height: the slider restyles a rendered prose line in the live editor, not only the Settings preview (SET3-07)", async ({
    page,
  }) => {
    jasper = await spawnJasper();
    const baseURL = jasper.baseURL;
    await page.setViewportSize({ width: 1512, height: 944 });

    await page.goto(baseURL);
    await waitForConnected(page);

    const noteTitle = "line-height-probe";
    const displayTitle = "Line height probe";
    const proseText = "Prose body line for line-height measurement.";
    await apiCreateNote(page, baseURL, `${noteTitle}.md`, "", `# ${displayTitle}\n\n${proseText}\n`);
    // Reload forces a fresh GET /tree strictly after the PUT above has
    // landed (see the "type preview" test's comment on this same pattern) —
    // the quick-switcher's client-side tree cache otherwise only refreshes
    // on note:created/moved/folder events, not note:updated.
    await page.reload();
    await waitForConnected(page);

    await page.keyboard.press("Meta+o");
    const switcher = page.getByRole("dialog", { name: "Quick switcher" });
    await switcher.waitFor({ state: "visible", timeout: 5_000 });
    await switcher.getByRole("combobox").fill(displayTitle);
    const noteRow = switcher.locator('[data-row-kind="note"]', { hasText: displayTitle });
    await expect(noteRow).toBeVisible({ timeout: 5_000 });
    await expect(noteRow).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("Enter");
    await expect(switcher).not.toBeVisible();

    const cmEditor = page.locator(".cm-editor").first();
    await expect(cmEditor).toBeVisible({ timeout: 10_000 });

    // Measured on the prose line itself, never .cm-editor (the wrapper the
    // broken value already reached) or an index-selected .cm-line (the
    // first line carries cm-heading-1, pinned to 1.3 regardless of this
    // control).
    const proseLine = page.locator(".cm-line", { hasText: proseText });
    await expect(proseLine).toHaveCount(1);
    const lineHeightBefore = await proseLine.evaluate((el) => getComputedStyle(el).lineHeight);
    const lineHeightConfigBefore = await page.request
      .get(`${baseURL}/api/v1/config`)
      .then(async (r) => ((await r.json()) as { editor: { lineHeight: number } }).editor.lineHeight);

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    // Settings always opens on Appearance — the line-height slider
    // is already the active pane; no extra nav click needed.

    const slider = dialog.getByRole("slider", { name: "Line height" });
    const box = await slider.boundingBox();
    if (!box) throw new Error("Line height slider has no bounding box");

    const y = box.y + box.height / 2;
    await page.mouse.move(box.x + 4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 4, y, { steps: 12 });

    // Live restyle, asserted BEFORE mouse-up so this cannot be satisfied by
    // the eventual onCommit alone.
    await expect(async () => {
      const lineHeightDuring = await proseLine.evaluate((el) => getComputedStyle(el).lineHeight);
      expect(lineHeightDuring).not.toBe(lineHeightBefore);
    }).toPass({ timeout: 3_000 });

    await page.mouse.up();

    // The release commits its own PATCH. Let it land before issuing a second
    // one — commitNumber does not await the slider's in-flight save, and the
    // server serialises writes without ordering them by dispatch time, so
    // otherwise the two writes' arrival order decides the persisted value.
    await expect
      .poll(
        async () => {
          const cfgResp = await page.request.get(`${baseURL}/api/v1/config`);
          return ((await cfgResp.json()) as { editor: { lineHeight: number } }).editor.lineHeight;
        },
        { timeout: 5_000, message: "waiting for the slider-release line-height PATCH to land" },
      )
      .not.toBe(lineHeightConfigBefore);

    // Pin an exact value through the paired numeric input.
    const spinbutton = dialog.getByRole("spinbutton", { name: "Line height" });
    await spinbutton.fill("2.5");
    await page.keyboard.press("Enter");

    await expect.poll(
      async () => {
        const cfgResp = await page.request.get(`${baseURL}/api/v1/config`);
        const cfg = await cfgResp.json();
        return cfg.editor.lineHeight as number;
      },
      { timeout: 5000, message: "waiting for line-height PATCH to land server-side" },
    ).toBe(2.5);

    // Ratio computed from the element's own metrics — no px literal
    // hard-coded, so float rounding cannot bite.
    await expect(async () => {
      const ratio = await proseLine.evaluate((el) => {
        const s = getComputedStyle(el);
        return parseFloat(s.lineHeight) / parseFloat(s.fontSize);
      });
      expect(Math.abs(ratio - 2.5)).toBeLessThan(0.02);
    }).toPass({ timeout: 3_000 });
  });
});
