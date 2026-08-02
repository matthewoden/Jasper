/**
 * Proves a second config commit from another session, while the first is still
 * unresolved, loses neither edit — and that tabbing through every Settings pane
 * unedited issues zero writes.
 *
 * The race is made deterministic by withholding session A's response through route
 * interception, never by firing two edits fast and hoping. A local server answers
 * within a keystroke, so a timing-based version passes even against the pre-fix
 * client — a green test documenting a bug.
 *
 * TWO sessions rather than one tab firing twice is also load-bearing:
 * useConfig.saveConfig's optimistic setConfig plus React's synchronous discrete-
 * event flush mean a single tab's second edit always reads the just-committed
 * value however the events are sequenced. Independent sessions have no such
 * protection, since no WS broadcast exists for PATCH /config.
 *
 * The two edited fields are leaves of the SAME nested `editor` object, so a
 * shallow top-level merge would replace the block and drop the other session's
 * write — that is what the assertion catches.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { waitForConnected } from "./helpers/phase7Helpers";

async function pollConfigField<T>(
  page: Page,
  baseURL: string,
  extract: (body: unknown) => T | null,
  expected: T,
  message: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        try {
          const resp = await page.request.get(`${baseURL}/api/v1/config`);
          if (!resp.ok()) return null;
          const body: unknown = await resp.json();
          return extract(body);
        } catch {
          return null;
        }
      },
      { timeout: 5000, message },
    )
    .toBe(expected);
}

test.describe("@phase32.1 concurrent settings edits + no-op writes", () => {
  let jasper: JasperHandle | undefined;

  test.afterEach(async () => {
    if (jasper) {
      await jasper.kill();
      jasper = undefined;
    }
  });

  test("concurrent settings edits: a second commit while the first is unresolved leaves both fields persisted", async ({
    context,
  }) => {
    jasper = await spawnJasper();
    const baseURL = jasper.baseURL;

    // Two INDEPENDENT sessions editing different leaves of the same nested
    // `editor` object. A single tab firing twice does NOT reproduce the bug —
    // see this file's header for why.
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    let patchCount = 0;
    let releaseFirstResponse: (() => void) | undefined;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });

    // Installed on session A only, BEFORE navigation, so the app's own
    // initial GET /config is unaffected (only PATCH is intercepted;
    // everything else — including session B's entire traffic — falls
    // through untouched).
    await pageA.route("**/api/v1/config", async (route) => {
      if (route.request().method() !== "PATCH") {
        await route.continue();
        return;
      }
      // route.fetch() sends the request to the REAL server — the write
      // actually lands — independent of when the response is released back
      // to session A below. Count AFTER it resolves, not on interception:
      // incrementing above would make the gate at "wait for PATCH #1 to land"
      // fire the instant the request was intercepted, before the proxied
      // request had even been sent, proving interception rather than arrival.
      const response = await route.fetch();
      patchCount++;
      // Withhold session A's PATCH response until the test releases the
      // gate, so session B's own PATCH is guaranteed to be dispatched while
      // session A's write is still "unresolved" from session A's own point
      // of view ('s exact wording) — a genuine overlap, not a race that
      // depends on relative request speed.
      await firstResponseGate;
      await route.fulfill({ response });
    });

    // Session B's own PATCH is never intercepted/withheld (goes straight
    // through) — this listener only counts it, so the `patchCount` total
    // below reflects both sessions' writes. `requestfinished`, not `request`:
    // patchCount must mean "this write landed" for BOTH sessions, or the
    // gates below compare a dispatch against an arrival.
    pageB.on("requestfinished", (req) => {
      if (req.method() === "PATCH" && req.url().endsWith("/api/v1/config")) {
        patchCount++;
      }
    });

    await pageA.goto(baseURL);
    await waitForConnected(pageA);
    await pageB.goto(baseURL);
    await waitForConnected(pageB);

    const dialogA = pageA.getByRole("dialog", { name: "Settings" });
    await pageA.getByTestId("settings-menu-trigger").click();
    await expect(dialogA).toBeVisible();
    // Session A stays on Appearance — Settings always opens there, no
    // nav click needed.

    const dialogB = pageB.getByRole("dialog", { name: "Settings" });
    await pageB.getByTestId("settings-menu-trigger").click();
    await expect(dialogB).toBeVisible();
    await dialogB.getByRole("button", { name: "Editor", exact: true }).click();

    const fontSizeInputA = dialogA.getByRole("spinbutton", { name: "Font size" });
    await fontSizeInputA.fill("22");
    await fontSizeInputA.blur(); // session A's PATCH #1 dispatched; server applies it; response withheld

    // Wait for PATCH #1 to actually land server-side — patchCount is
    // incremented only after route.fetch() resolves, so this observes arrival
    // rather than interception, independent of the withheld response — before
    // session B commits — session B's own config was never going to see
    // this either way, but this ordering keeps the "second write while the
    // first is unresolved" framing precise and avoids a benign write-order
    // ambiguity at the assertion below.
    await expect.poll(() => patchCount, { timeout: 5000 }).toBe(1);

    const autosaveInputB = dialogB.getByRole("spinbutton", { name: "Autosave interval" });
    await autosaveInputB.fill("4500");
    await autosaveInputB.blur(); // session B's PATCH #2, built from session B's own still-v1 config

    await expect.poll(() => patchCount, { timeout: 5000 }).toBe(2);

    releaseFirstResponse?.();

    // Server truth is the only proof a write landed — never `toHaveValue` on
    // the inputs, which is exactly what the defect makes lie (the useEffect
    // re-seed silently reverts the input back to a stale value). fontSize
    // and autosaveMs are two LEAVES of the same nested `editor` object, which
    // keeps this merge-equivalent to the retired dailyNotes.folder /
    // dailyNotes.template pair — not stronger than it: a shallow top-level
    // merge of session B's `{editor:{autosaveMs}}` would replace the whole
    // `editor` block and silently drop session A's fontSize write.
    await pollConfigField(
      pageA,
      baseURL,
      (body) => (body as { editor?: { fontSize?: number } }).editor?.fontSize ?? null,
      22,
      "waiting for editor.fontSize to land server-side",
    );
    await pollConfigField(
      pageA,
      baseURL,
      (body) => (body as { editor?: { autosaveMs?: number } }).editor?.autosaveMs ?? null,
      4500,
      "waiting for editor.autosaveMs to land server-side",
    );

    // Exactly 2 PATCHes: proof the dirty checks did not suppress a real
    // edit, and no extra write snuck in.
    expect(patchCount).toBe(2);

    await pageA.close();
    await pageB.close();
  });

  test("tabbing through Settings without changing a value issues zero config writes", async ({
    page,
  }) => {
    jasper = await spawnJasper();
    const baseURL = jasper.baseURL;
    await page.setViewportSize({ width: 1512, height: 944 });
    await page.goto(baseURL);
    await waitForConnected(page);

    let writeCount = 0;
    page.on("request", (req) => {
      if (!req.url().endsWith("/api/v1/config")) return;
      const method = req.method();
      if (method === "PATCH" || method === "PUT") writeCount++;
    });

    await page.getByTestId("settings-menu-trigger").click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await expect(dialog).toBeVisible();

    // Settings always opens on Appearance — no nav click needed.
    const fontSizeInput = dialog.getByRole("spinbutton", { name: "Font size" });
    await fontSizeInput.focus();
    await fontSizeInput.blur();

    const lineHeightInput = dialog.getByRole("spinbutton", { name: "Line height" });
    await lineHeightInput.focus();
    await lineHeightInput.blur();

    // Click the already-selected accent swatch and the already-active
    // reading-font pill — both handlers no-op before any write when the
    // clicked value already matches config.
    const activeAccentSwatch = dialog
      .getByRole("group", { name: "Accent color" })
      .locator('[aria-pressed="true"]');
    await expect(activeAccentSwatch).toHaveCount(1);
    await activeAccentSwatch.click();

    const activeReadingFontPill = dialog
      .getByRole("group", { name: "Reading font" })
      .locator('[aria-pressed="true"]');
    await expect(activeReadingFontPill).toHaveCount(1);
    await activeReadingFontPill.click();

    // pointerUp on a slider without dragging it. A real page.mouse down+up
    // at any point on a native <input type="range"> jumps the thumb to that
    // click position (browser click-to-position behavior, unrelated to this
    // app's code) — pixel-matching the current value's exact thumb position
    // is not reliably reproducible cross-run and would make this assertion
    // flaky. dispatchEvent fires the single genuine `pointerup` event the
    // app's onPointerUp handler listens for, with no preceding `input` event
    // and therefore no change to React's `sliderValue` state — accurately
    // representing "released without ever dragging," never a fabricated
    // sequence of fake intermediate positions.
    const lineHeightSlider = dialog.getByRole("slider", { name: "Line height" });
    await lineHeightSlider.dispatchEvent("pointerup");

    await dialog.getByRole("button", { name: "Editor", exact: true }).click();
    const autosaveInput = dialog.getByRole("spinbutton", { name: "Autosave interval" });
    await autosaveInput.focus();
    await autosaveInput.blur();

    await dialog.getByRole("button", { name: "Daily notes" }).click();
    const templateInput = dialog.getByRole("textbox", { name: "Daily note template" });
    await templateInput.focus();
    await templateInput.blur();

    expect(writeCount).toBe(0);

    // Positive control: a future regression that disables all writes must
    // not make the assertion above pass vacuously — change one real value
    // and confirm exactly one write is observed.
    await templateInput.fill("## {{date}}\n\nnoop probe\n");
    await templateInput.blur();

    await pollConfigField(
      page,
      baseURL,
      (body) => (body as { dailyNotes?: { template?: string } }).dailyNotes?.template ?? null,
      "## {{date}}\n\nnoop probe\n",
      "waiting for dailyNotes.template PATCH to land server-side",
    );

    expect(writeCount).toBe(1);
  });
});
