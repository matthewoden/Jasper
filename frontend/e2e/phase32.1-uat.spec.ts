/**
 * Phase 32.1 UAT spec (D-06 E2E half, WR-06): proves both halves of WR-06's
 * exact reported scenario end-to-end against the real embedded binary — a
 * second commit from another session while the first is still unresolved
 * must not lose either edit, and an unedited tab-through of every Settings
 * pane must issue zero config write requests.
 *
 * CRITICAL (memory e2e-needs-make-build): run `make build` (NOT `npm run
 * build`) before Playwright — this spec runs against the EMBEDDED binary,
 * not the Vite dev server.
 *
 * Discipline: zero fixed-duration sleeps. The concurrency scenario uses TWO
 * independent sessions (separate pages, each its own React tree and its own
 * `useConfig()` state) editing different fields, made deterministic via
 * response-withholding route interception on session A (a real
 * request/response round-trip against the live server, with only the
 * response's arrival at session A delayed) — never "fire two edits fast and
 * hope they race", which a local server usually answers within a keystroke,
 * making a timing-based version pass even against the pre-fix client (a
 * green test documenting a bug, exactly what quick task `260726-ked` had to
 * clean up after `phase32-uat.spec.ts`'s original 157-168 raced this same
 * defect). Two sessions rather than one tab firing two events is also load-
 * bearing for a different reason: `useConfig.saveConfig`'s optimistic
 * `setConfig` (plan 03) plus React's synchronous discrete-event flush for
 * blur/focusout mean a SINGLE tab's second edit always reads the
 * just-committed value, regardless of how the two events are sequenced or
 * how many yield points separate them — confirmed empirically by
 * instrumenting the intercepted PATCH body against the reintroduced
 * stale-base spread. Two independent sessions have no such protection
 * (config changes are never pushed to other sessions — no WS broadcast
 * exists for `PATCH /config`), so this is also the more faithful
 * reproduction of "Settings is reachable from multiple sessions" (D-02's own
 * stated reason server-side serialisation was chosen over a client-side
 * queue). Every timing-sensitive assertion here uses Playwright's own
 * auto-retrying `expect`/`expect.poll` plus the explicit route gate — no
 * fixed-duration timer of any kind.
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

test.describe("@phase32.1 D-06: concurrent settings edits + no-op writes (WR-06)", () => {
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

    // Two INDEPENDENT sessions (separate pages, each its own React tree and
    // its own `useConfig()` state) editing DIFFERENT Daily-notes fields —
    // this is the deterministic, faithful reproduction of WR-06 in the
    // shipped codebase.
    //
    // A single-tab "fire two edits fast" version (even one driven by
    // synchronous, zero-yield native DOM events dispatched from a single
    // in-page script, bypassing Playwright's own per-action round-trips)
    // does NOT reproduce the bug here: `useConfig.saveConfig`'s optimistic
    // `setConfig(mergePatch(prev, patch))` (plan 03) runs synchronously
    // before the network await, and React flushes discrete events (blur/
    // focusout) synchronously before the dispatching call returns — so by
    // the time ANY second same-tab event fires, the closure already reads
    // the just-committed value, even against the reintroduced stale-base
    // spread. Confirmed empirically: instrumenting the intercepted PATCH
    // body showed PATCH #2 already carrying the corrected `folder` in both
    // a two-action Playwright sequence AND a single synchronous-dispatch
    // script.
    //
    // Two separate sessions have no such protection: there is no WebSocket
    // (or any other) push of config changes to other sessions (verified —
    // `backend/internal/api/config_handler.go` never calls the broadcaster),
    // so session B's `config` state never learns about session A's edit
    // without an explicit refetch. This is exactly the case D-02's own
    // rationale names as unfixable client-side ("a client-side queue...
    // only holds within a single tab; Settings is reachable from multiple
    // sessions") — which is why the fix is the sparse payload (this test)
    // plus server-side serialisation (plan 01), not a client-side lock.
    const pageA = await context.newPage();
    const pageB = await context.newPage();

    const distinctTemplate = "# {{date}} journal\n\nnotes\n";

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
      patchCount++;
      // route.fetch() sends the request to the REAL server — the write
      // actually lands — independent of when the response is released back
      // to session A below.
      const response = await route.fetch();
      // Withhold session A's PATCH response until the test releases the
      // gate, so session B's own PATCH is guaranteed to be dispatched while
      // session A's write is still "unresolved" from session A's own point
      // of view (D-06's exact wording) — a genuine overlap, not a race that
      // depends on relative request speed.
      await firstResponseGate;
      await route.fulfill({ response });
    });

    // Session B's own PATCH is never intercepted/withheld (goes straight
    // through) — this listener only counts it, so the `patchCount` total
    // below reflects both sessions' writes.
    pageB.on("request", (req) => {
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
    await dialogA.getByRole("button", { name: "Daily notes" }).click();

    const dialogB = pageB.getByRole("dialog", { name: "Settings" });
    await pageB.getByTestId("settings-menu-trigger").click();
    await expect(dialogB).toBeVisible();
    await dialogB.getByRole("button", { name: "Daily notes" }).click();

    const folderInputA = dialogA.getByRole("textbox", { name: "Daily notes folder" });
    await folderInputA.fill("journal");
    await folderInputA.blur(); // session A's PATCH #1 dispatched; server applies it; response withheld

    // Wait for PATCH #1 to actually land server-side (proxied through
    // route.fetch() above, independent of the withheld response) before
    // session B commits — session B's own config was never going to see
    // this either way, but this ordering keeps the "second write while the
    // first is unresolved" framing precise and avoids a benign write-order
    // ambiguity at the assertion below.
    await expect.poll(() => patchCount, { timeout: 5000 }).toBe(1);

    const templateInputB = dialogB.getByRole("textbox", { name: "Daily note template" });
    await templateInputB.fill(distinctTemplate);
    await templateInputB.blur(); // session B's PATCH #2, built from session B's own still-v1 config

    await expect.poll(() => patchCount, { timeout: 5000 }).toBe(2);

    releaseFirstResponse?.();

    // Server truth is the only proof a write landed — never `toHaveValue` on
    // the inputs, which is exactly what the defect makes lie (the useEffect
    // re-seed silently reverts the input back to a stale value).
    await pollConfigField(
      pageA,
      baseURL,
      (body) => (body as { dailyNotes?: { folder?: string } }).dailyNotes?.folder ?? null,
      "journal",
      "waiting for dailyNotes.folder to land server-side",
    );
    await pollConfigField(
      pageA,
      baseURL,
      (body) => (body as { dailyNotes?: { template?: string } }).dailyNotes?.template ?? null,
      distinctTemplate,
      "waiting for dailyNotes.template to land server-side",
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

    // Settings always opens on Appearance (D-20) — no nav click needed.
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
    const folderInput = dialog.getByRole("textbox", { name: "Daily notes folder" });
    await folderInput.focus();
    await folderInput.blur();

    const templateInput = dialog.getByRole("textbox", { name: "Daily note template" });
    await templateInput.focus();
    await templateInput.blur();

    expect(writeCount).toBe(0);

    // Positive control: a future regression that disables all writes must
    // not make the assertion above pass vacuously — change one real value
    // and confirm exactly one write is observed.
    await folderInput.fill("journal2");
    await folderInput.blur();

    await pollConfigField(
      page,
      baseURL,
      (body) => (body as { dailyNotes?: { folder?: string } }).dailyNotes?.folder ?? null,
      "journal2",
      "waiting for dailyNotes.folder PATCH to land server-side",
    );

    expect(writeCount).toBe(1);
  });
});
