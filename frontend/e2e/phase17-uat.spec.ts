/**
 * Phase 17 UAT — Design Tokens & Theme Foundation.
 *
 * THEME-01: Dark token palette applied across all surfaces
 *   Editor bg #1e1e21, sidebar/chrome #1a1a1c, body #d4d4d8, muted #6a6a72.
 * THEME-02: 4-accent system in place with accent-tint pattern
 *   Default --color-accent = #a78bfa; active row tint is non-zero-alpha accent mix.
 * THEME-03: User picks accent in Settings; change applies live without reload, persists.
 *   aria-label="Sky" swatch sets --color-accent to #7dd3fc; survives page reload.
 * THEME-04: Code font = JetBrains Mono; reading-font toggle reflects in note surface.
 *   Code fence computed font-family contains "JetBrains Mono"; after "Serif" toggle,
 *   prose surface switches to "Source Serif 4" while code stays mono (D-04).
 *
 * These tests are in RED state until Waves 2–3 land. Do NOT weaken assertions to
 * make them pass prematurely.
 *
 * Harness mirrors phase11-uat.spec.ts: spawnJasper per describe block, beforeAll/afterAll.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

// ---------------------------------------------------------------------------
// THEME-01: Dark token palette
// ---------------------------------------------------------------------------

test.describe("THEME-01: Dark token palette (@phase17)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  async function waitConnected(page: Page): Promise<void> {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );
  }

  test("editor surface background equals rgb(30, 30, 33) (#1e1e21) @THEME-01", async ({ page }) => {
    await waitConnected(page);
    // Open the first available note so the editor is mounted.
    const noteRow = page.locator('[data-tree-row-kind="note"]').first();
    await expect(noteRow).toBeVisible({ timeout: 10_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    const editorBg = await page.evaluate(() => {
      const el = document.querySelector(".cm-editor");
      if (!el) return null;
      return getComputedStyle(el).backgroundColor;
    });
    // --color-bg remapped to #1e1e21 → rgb(30, 30, 33)
    expect(editorBg).toBe("rgb(30, 30, 33)");
  });

  test("sidebar/chrome surface equals rgb(26, 26, 28) (#1a1a1c) @THEME-01", async ({ page }) => {
    await waitConnected(page);

    const sidebarBg = await page.evaluate(() => {
      // The sidebar card uses background: var(--color-surface)
      // It is the first div inside the sidebar container that has an explicit background.
      const el =
        document.querySelector<HTMLElement>("[data-testid='sidebar-toolbar']") ??
        document.querySelector<HTMLElement>("[class*='sidebar']");
      if (!el) return null;
      // Walk up to find the element with --color-surface applied
      let current: HTMLElement | null = el;
      while (current) {
        const bg = getComputedStyle(current).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return bg;
        current = current.parentElement;
      }
      return null;
    });
    // --color-surface remapped to #1a1a1c → rgb(26, 26, 28)
    expect(sidebarBg).toBe("rgb(26, 26, 28)");
  });

  test("body text color resolves to rgb(212, 212, 216) (#d4d4d8) @THEME-01", async ({ page }) => {
    await waitConnected(page);

    const bodyColor = await page.evaluate(() => getComputedStyle(document.body).color);
    // --color-fg remapped to #d4d4d8 → rgb(212, 212, 216)
    expect(bodyColor).toBe("rgb(212, 212, 216)");
  });

  test("--color-muted CSS var resolves to #6a6a72 (rgb(106, 106, 114)) @THEME-01", async ({ page }) => {
    await waitConnected(page);

    const mutedVal = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-muted").trim(),
    );
    // --color-muted remapped to #6a6a72
    expect(mutedVal).toBe("#6a6a72");
  });
});

// ---------------------------------------------------------------------------
// THEME-02: 4-accent system
// ---------------------------------------------------------------------------

test.describe("THEME-02: 4-accent system (@phase17)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("default --color-accent is #a78bfa (rgb(167, 139, 250)) @THEME-02", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Accent default: purple #a78bfa. This should be on :root or set as inline style via bootstrap.
    const accentVal = await page.evaluate(() => {
      // Check inline style first (set by bootstrap), then computed :root value.
      const inline = document.documentElement.style.getPropertyValue("--color-accent").trim();
      if (inline) return inline;
      return getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim();
    });
    expect(accentVal).toBe("#a78bfa");
  });

  test("active tree row background is non-zero-alpha accent-derived tint @THEME-02", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Click the first note to make its row "active".
    const noteRow = page.locator('[data-tree-row-kind="note"]').first();
    await expect(noteRow).toBeVisible({ timeout: 10_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // The active row should have a background that is not fully transparent and not a flat gray.
    // Active fill: color-mix(in srgb, var(--color-accent) 16%, transparent)
    const activeRowBg = await page.evaluate(() => {
      const activeRows = document.querySelectorAll('[data-tree-row-kind="note"]');
      for (const row of activeRows) {
        const bg = getComputedStyle(row).backgroundColor;
        if (bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent" && bg !== "rgb(0, 0, 0)") {
          return bg;
        }
      }
      return null;
    });
    // Must be non-null and contain rgba (color-mix produces rgba with non-zero alpha)
    expect(activeRowBg).not.toBeNull();
    expect(activeRowBg).toContain("rgba");
  });
});

// ---------------------------------------------------------------------------
// THEME-03: Accent picker — live apply + persistence
// ---------------------------------------------------------------------------

test.describe("THEME-03: Accent picker (@phase17)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("clicking Sky swatch sets --color-accent to #7dd3fc without page reload @THEME-03", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Set a sentinel on window to detect a reload would clear it.
    await page.evaluate(() => {
      (window as typeof window & { __jasperSentinel: number }).__jasperSentinel = 42;
    });

    // Open Settings (matches aria-label / testid pattern from phase11-uat.spec.ts).
    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Click the "Sky" accent swatch. The aria-label comes from the UI-SPEC Copywriting Contract.
    await page.getByRole("button", { name: "Sky" }).click();

    // --color-accent must update to #7dd3fc (Sky hex from UI-SPEC Accent System table).
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--color-accent").trim(),
          ),
        { message: "Expected --color-accent to be #7dd3fc after Sky swatch click" },
      )
      .toBe("#7dd3fc");

    // Verify no page reload occurred: sentinel must still be 42.
    const sentinel = await page.evaluate(
      () => (window as typeof window & { __jasperSentinel?: number }).__jasperSentinel,
    );
    expect(sentinel).toBe(42);

    await page.getByRole("button", { name: "Close" }).click();
  });

  test("Sky accent persists across page reload (localStorage bootstrap) @THEME-03", async ({ page }) => {
    // Navigate to the app once to set the accent to Sky.
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "Sky" }).click();

    await expect
      .poll(
        () =>
          page.evaluate(() =>
            document.documentElement.style.getPropertyValue("--color-accent").trim(),
          ),
        { message: "Expected --color-accent to be #7dd3fc after Sky swatch click" },
      )
      .toBe("#7dd3fc");

    await page.getByRole("button", { name: "Close" }).click();

    // Reload and verify accent is restored via localStorage bootstrap (before React mounts).
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const accentAfterReload = await page.evaluate(() =>
      document.documentElement.style.getPropertyValue("--color-accent").trim(),
    );
    // Bootstrap must have applied #7dd3fc before React mounted (no flash).
    expect(accentAfterReload).toBe("#7dd3fc");
  });
});

// ---------------------------------------------------------------------------
// THEME-04: Font delivery — JetBrains Mono + reading-font toggle
// ---------------------------------------------------------------------------

test.describe("THEME-04: Font delivery and reading-font toggle (@phase17)", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  // Unique title per creation: the three THEME-04 tests share one jasper
  // instance (beforeAll), so a fixed title collides on the 2nd/3rd create
  // (case/path collision → 409). Sequence guarantees a distinct file per test.
  let fontNoteSeq = 0;

  /**
   * Create a note with a code fence via the API, open it in the editor,
   * and return the note ID.
   */
  async function createCodeFenceNote(page: Page): Promise<string> {
    const createResp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
      data: { parent_path: "", title: `Font Test Note ${++fontNoteSeq}` },
    });
    if (createResp.status() !== 201) {
      throw new Error(`Failed to create note: ${String(createResp.status())}`);
    }
    const created = (await createResp.json()) as { id: string };
    const id = created.id;

    const updateResp = await page.request.put(`${jasper.baseURL}/api/v1/notes/${id}`, {
      data: { content: "# Font Test\n\n```\nconst x = 1;\n```\n\nProse text here.\n" },
    });
    if (updateResp.status() !== 200) {
      throw new Error(`Failed to update note: ${String(updateResp.status())}`);
    }
    return id;
  }

  test("code-fence line computed font-family contains 'JetBrains Mono' @THEME-04", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const noteId = await createCodeFenceNote(page);

    // Open the note in the editor.
    await expect(
      page.locator('[data-tree-row-kind="note"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    const noteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // A code fence line inside the CM6 editor uses .cm-codeblock (themeBridge).
    // The computed font-family must contain "JetBrains Mono" (D-04).
    const codeFontFamily = await page.evaluate(() => {
      const codeblock = document.querySelector(".cm-codeblock");
      if (!codeblock) return null;
      return getComputedStyle(codeblock).fontFamily;
    });
    expect(codeFontFamily).not.toBeNull();
    expect(codeFontFamily).toContain("JetBrains Mono");
  });

  test("toggling 'Serif' reading font: prose uses Source Serif 4, code stays mono @THEME-04", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const noteId = await createCodeFenceNote(page);

    // Open the note.
    await expect(
      page.locator('[data-tree-row-kind="note"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    const noteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Open Settings and toggle reading font to "Serif".
    // The UI-SPEC Copywriting Contract defines:
    //   - Group aria-label: "Reading font"
    //   - Option: "Serif" (alternate)
    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Click the "Serif" button inside the "Reading font" group (D-03, D-04).
    const readingFontGroup = page.getByRole("group", { name: "Reading font" });
    await readingFontGroup.getByRole("button", { name: "Serif" }).click();

    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // After toggling Serif, the rendered .cm-content should compute "Source
    // Serif 4" (D-03). Assert on .cm-content, never .cm-editor — .cm-editor
    // (the &-rule) already carries var(--font-reading) pre-fix and doesn't
    // prove the value reaches the rendered text (the exact false-green).
    const proseContentFontFamily = await page
      .locator(".cm-content")
      .evaluate((el) => getComputedStyle(el).fontFamily);
    expect(proseContentFontFamily).toContain("Source Serif 4");

    // Prove the RENDERED text line inherits it, not just the container.
    const proseLine = page.locator(".cm-line").filter({ hasText: "Prose text here." });
    await expect
      .poll(() => proseLine.evaluate((el) => getComputedStyle(el).fontFamily))
      .toContain("Source Serif 4");

    // Code fences must still use JetBrains Mono regardless of reading-font choice (D-04).
    const codeFontFamilyAfterToggle = await page.evaluate(() => {
      const codeblock = document.querySelector(".cm-codeblock");
      if (!codeblock) return null;
      return getComputedStyle(codeblock).fontFamily;
    });
    expect(codeFontFamilyAfterToggle).not.toBeNull();
    expect(codeFontFamilyAfterToggle).toContain("JetBrains Mono");
  });

  test("default (sans) reading font reaches rendered .cm-line, not just .cm-editor @THEME-04", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const noteId = await createCodeFenceNote(page);

    await expect(
      page.locator('[data-tree-row-kind="note"]').first(),
    ).toBeVisible({ timeout: 10_000 });
    const noteRow = page.locator(`[data-tree-row="${noteId}"][data-tree-row-kind="note"]`);
    await expect(noteRow).toBeVisible({ timeout: 8_000 });
    await noteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Hermetic reset: these THEME-04 tests share one jasper instance, and the
    // sibling "Serif" test persists readingFont=serif to the shared vault
    // config. Explicitly re-select the default "Sans" so this test proves the
    // default (sans) contract regardless of execution order (no cross-test
    // state leakage). Selecting Sans is idempotent if already default.
    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();
    await page.getByRole("group", { name: "Reading font" }).getByRole("button", { name: "Sans" }).click();
    await page.getByRole("button", { name: "Close" }).click();
    await expect(dialog).not.toBeVisible();

    // Default (sans) mode: rendered prose line must be proportional, never
    // monospace. This is the exact case the P0 bug broke — pins the fix.
    const proseLine = page.locator(".cm-line").filter({ hasText: "Prose text here." });
    await expect
      .poll(() => proseLine.evaluate((el) => getComputedStyle(el).fontFamily))
      .toContain("ui-sans-serif");
    const fontFamily = await proseLine.evaluate((el) => getComputedStyle(el).fontFamily);
    expect(fontFamily).not.toContain("monospace");
    expect(fontFamily).toContain("ui-sans-serif");
  });
});
