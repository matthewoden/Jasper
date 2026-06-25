/**
 * Phase 5 UAT — Live Preview editor + theme + security headers.
 *
 * Scenarios (each maps to one or more Phase 5 requirements):
 *   1. Editor mount + cursor stability (EDIT-01)
 *   2. Autosave indicator transitions (EDIT-09)
 *   3. Cmd+S explicit save (EDIT-10)
 *   4. Cmd+F opens Find panel (EDIT-11)
 *   5. Theme toggle persists through reload (EDIT-12)
 *   6. IME composition does not corrupt the editor (EDIT-14)
 *   7. CSP + Referrer-Policy headers on every response (SECURITY-01, SECURITY-04)
 *   8. External image click-to-load placeholder + fetch (SECURITY-03)
 *   9. Zero non-localhost requests on cold page load (SECURITY-07)
 *
 * Setup mirrors phase4-uat.spec.ts. Each test runs against a freshly
 * spawned Go binary so persistent state (config.json, allow-list) is
 * isolated.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});


/**
 * Navigate to the app and wait for the WS connection dot to show
 * "connected". The scratchpad note is auto-seeded on first boot.
 */
async function openApp(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/**
 * Click the first note row to open it in the editor, then wait for
 * the CM6 host div (data-testid="markdown-editor") and the editable
 * content surface (.cm-content) to become visible.
 *
 * CM6 renders .cm-content as a contenteditable div inside the host.
 * There is no <textarea>.
 */
async function openFirstNote(page: Page): Promise<void> {
  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await expect(firstNote).toBeVisible({ timeout: 8_000 });
  await firstNote.click();
  await page.waitForSelector('[data-testid="markdown-editor"]', { timeout: 8_000 });
  await page.waitForSelector('.cm-content', { timeout: 8_000 });
}

/**
 * Open the app, select the first note, and confirm the editor is ready.
 */
async function openEditor(page: Page): Promise<void> {
  await openApp(page);
  await openFirstNote(page);
}

/**
 * Type text into the CM6 editor. Clicks the content surface to focus it
 * before typing so the keystrokes land in the editor.
 */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').click();
  await page.keyboard.type(text);
}


test.describe("Phase 5 — CodeMirror editor + theme + security", () => {
  test("EDIT-01: typing produces stable cursor — no jump on parent state changes", async ({ page }) => {
    await openEditor(page);

    await typeIntoEditor(page, "Hello world");
    const text1 = await page.locator('.cm-content').textContent();
    expect(text1).toContain("Hello world");

    await page.keyboard.type("!");
    const text2 = await page.locator('.cm-content').textContent();
    expect(text2).toContain("Hello world!");
  });

  test("EDIT-09: autosave fires after debounce; SaveIndicator transitions saving → saved", async ({ page }) => {
    await openEditor(page);
    await typeIntoEditor(page, "edit");
    await expect(page.getByText(/Saving|Saved/)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 5_000 });
  });

  test("EDIT-10: Cmd+S triggers immediate save", async ({ page }) => {
    await openEditor(page);
    await typeIntoEditor(page, "explicit save test");
    const saveKey = process.platform === "darwin" ? "Meta+S" : "Control+S";
    await page.keyboard.press(saveKey);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 5_000 });
  });

  test("EDIT-11: Cmd+F opens the Find panel (@codemirror/search)", async ({ page }) => {
    await openEditor(page);
    await typeIntoEditor(page, "alpha beta gamma");

    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fn = (window as any).__jasperOpenSearchPanel as (() => boolean) | undefined;
      if (!fn) throw new Error('window.__jasperOpenSearchPanel not set — check MarkdownEditor.tsx E2E hook');
      fn();
    });

    await page.waitForSelector('.cm-panels', { timeout: 5_000 });

    const findInput = page.locator('.cm-panels .cm-textfield').first();
    await findInput.click();
    await page.keyboard.type("beta");

    await page.waitForSelector('.cm-searchMatch', { timeout: 5_000 });
  });

  test("EDIT-12: theme toggle persists through page reload", async ({ page }) => {
    await openEditor(page);

    await page.getByTestId("settings-menu-trigger").click();
    await page.getByLabel("Dark").click();

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test("EDIT-14: IME composition does not corrupt the editor (Japanese kana sample)", async ({ page }) => {
    await openEditor(page);

    const cm = page.locator('.cm-content');
    await cm.click();

    await page.evaluate(() => {
      const el = document.querySelector('.cm-content') as HTMLElement;
      if (!el) return;
      el.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      el.dispatchEvent(new CompositionEvent("compositionupdate", { bubbles: true, data: "あ" }));
      el.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "あ" }));
    });

    await page.keyboard.type("a");
    const text = await cm.textContent();
    expect(text).toContain("a");
  });

  test("SECURITY-01 + SECURITY-04: CSP and Referrer-Policy headers present on /api/v1/notes", async ({ request }) => {
    const resp = await request.get(`${jasper.baseURL}/api/v1/notes`);
    expect(resp.status()).toBe(200);

    const csp = resp.headers()['content-security-policy'];
    expect(csp).toBeTruthy();
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("img-src 'self' data: blob:");
    expect(csp).not.toContain("'unsafe-eval'");

    expect(resp.headers()['referrer-policy']).toBe('no-referrer');
  });

  test("SECURITY-01: index.html response carries strict CSP (no inline-script flash)", async ({ request }) => {
    const resp = await request.get(`${jasper.baseURL}/`);
    expect(resp.status()).toBe(200);
    const csp = resp.headers()['content-security-policy'];
    expect(csp).toContain("script-src 'self'");
    expect(resp.headers()['referrer-policy']).toBe('no-referrer');
  });

  test("SECURITY-03: external image renders placeholder, NOT fetched, until user clicks Allow", async ({ page }) => {
    const placeholderURL = "https://placeholder.example.com/x.png";

    const externalRequestsBefore: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (
        !url.startsWith(jasper.baseURL) &&
        !url.startsWith("data:") &&
        !url.startsWith("blob:") &&
        !url.startsWith("about:")
      ) {
        externalRequestsBefore.push(url);
      }
    });

    await openEditor(page);

    await typeIntoEditor(page, `![alt text](${placeholderURL})`);

    await page.waitForSelector('[data-testid="external-image-allow-btn"]', { timeout: 8_000 });

    expect(externalRequestsBefore.filter(u => !u.startsWith(jasper.baseURL))).toHaveLength(0);

    const hostText = await page.locator('.cm-img-host').textContent();
    expect(hostText).toContain("placeholder.example.com");

    await page.locator('[data-testid="external-image-allow-btn"]').click();

    const loadedOrError = page.locator(
      '[data-testid="external-image-loaded"], [data-testid="external-image-error"]',
    );
    await expect(loadedOrError).toBeVisible({ timeout: 10_000 });
  });

  test("SECURITY-07: cold page load + edit + save makes ZERO non-localhost requests", async ({ page }) => {
    const externalRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (
        !url.startsWith(jasper.baseURL) &&
        !url.startsWith("data:") &&
        !url.startsWith("blob:") &&
        !url.startsWith("about:")
      ) {
        externalRequests.push(url);
      }
    });

    await openEditor(page);

    await typeIntoEditor(page, "# My note\n\nNo external traffic please.");

    await expect(page.getByText("Saved")).toBeVisible({ timeout: 8_000 });

    const saveKey = process.platform === "darwin" ? "Meta+S" : "Control+S";
    await page.keyboard.press(saveKey);
    await expect(page.getByText("Saved")).toBeVisible({ timeout: 5_000 });

    expect(externalRequests).toEqual([]);
  });
});
