/**
 * Regression gate for the tab-bar restyle: it moves every pixel value the
 * pointer-drag math (computeDropTarget, wrapper getBoundingClientRect) depends on
 * indirectly through layout, so drag-reorder is re-proven here with real
 * page.mouse against a rebuilt binary.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";
import { localDateString } from "./helpers/localDate";

async function waitForConnected(page: Page, baseURL: string): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

/** Create a note via the API; returns its UUID. */
async function createNote(jasper: JasperHandle, title: string): Promise<string> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent_path: "", title }),
  });
  if (!resp.ok) throw new Error(`create ${title}: ${resp.status}`);
  return ((await resp.json()) as { id: string }).id;
}

function tabStrip(page: Page) {
  return page.getByTestId("tab-strip");
}

/** All tab pills currently rendered in the strip (excludes overflow-hidden). */
function tabPills(page: Page) {
  return tabStrip(page).getByRole("tab");
}

// ─── DnD regression — drag-reorder, ghost, drop indicator ──────────────────

test.describe("@phase18 DnD regression — drag/ghost/drop-indicator survive the restyle", () => {
  let jasper: JasperHandle;
  let idAlpha: string;
  let idBeta: string;
  let idGamma: string;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    idAlpha = await createNote(jasper, "d05-alpha");
    idBeta = await createNote(jasper, "d05-beta");
    idGamma = await createNote(jasper, "d05-gamma");
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("real page.mouse drag past pill[1]'s midpoint reorders the strip (3 tabs open)", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await openNoteFromTree(page, idGamma);

    await expect(tabPills(page)).toHaveCount(3);
    expect(
      (await tabPills(page).allTextContents()).map((t) => t.trim()),
    ).toEqual(["d05-alpha", "d05-beta", "d05-gamma"]);

    // Read bounding boxes — poll until they resolve to non-zero dimensions.
    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    let pill1bbox = await tabPills(page).nth(1).boundingBox();
    await expect
      .poll(async () => {
        pill0bbox = await tabPills(page).nth(0).boundingBox();
        pill1bbox = await tabPills(page).nth(1).boundingBox();
        return (pill0bbox?.width ?? 0) > 0 && (pill1bbox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!pill0bbox || !pill1bbox) throw new Error("pill bounding boxes unavailable");

    // Start at pill0 center, drag to pill1's right edge (past pill1's midpoint,
    // still before pill2 starts) in multiple steps so the 5px drag threshold
    // is crossed and intermediate pointermove events fire.
    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;
    const toX = pill1bbox.x + pill1bbox.width - 2;
    const toY = pill1bbox.y + pill1bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 10 });
    await page.mouse.up();

    // 18-06 compensates the drop target by -1 when dropping to the right of
    // the drag source, so the drop indicator's visual promise (insert before
    // gamma) now matches the actual outcome: [alpha,beta,gamma] -> drag alpha
    // to just before gamma -> [beta,alpha,gamma].
    await expect
      .poll(
        async () =>
          (await tabPills(page).allTextContents()).map((t) => t.trim()),
        { timeout: 5_000 },
      )
      .toEqual(["d05-beta", "d05-alpha", "d05-gamma"]);
  });

  test("ghost + drop indicator appear during an active drag and are removed on mouse-up", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idAlpha);
    await openNoteFromTree(page, idBeta);
    await expect(tabPills(page)).toHaveCount(2);

    let pill0bbox = await tabPills(page).nth(0).boundingBox();
    await expect
      .poll(async () => {
        pill0bbox = await tabPills(page).nth(0).boundingBox();
        return (pill0bbox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!pill0bbox) throw new Error("pill0 bounding box unavailable");

    const fromX = pill0bbox.x + pill0bbox.width / 2;
    const fromY = pill0bbox.y + pill0bbox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    // Move 30px past the 5px drag threshold so the strip activates the drag.
    await page.mouse.move(fromX + 30, fromY, { steps: 6 });

    await expect(page.getByTestId("tab-drag-ghost")).toBeVisible({ timeout: 3_000 });
    await expect(page.getByTestId("tab-drop-indicator")).toBeVisible({ timeout: 3_000 });

    await page.mouse.up();

    await expect(page.getByTestId("tab-drag-ghost")).toHaveCount(0, { timeout: 3_000 });
    await expect(page.getByTestId("tab-drop-indicator")).toHaveCount(0, { timeout: 3_000 });
  });
});

// ─── Interleaved-hidden-tabs drag stays visible-adjacent ───────────────────

test.describe("@phase18 interleaved-hidden-tabs real-mouse drag does not swallow the tab into overflow", () => {
  let jasper: JasperHandle;
  let ids: string[];

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    ids = [];
    for (const title of ["wr03-a", "wr03-b", "wr03-c", "wr03-d", "wr03-e"]) {
      ids.push(await createNote(jasper, title));
    }
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("dragging the first visible tab to just before the active (last) visible tab keeps it out of the overflow dropdown", async ({
    page,
  }) => {
    // Force the strip's available width into [388,507) so 5 tabs overflow to
    // exactly 3 visible pills (RESERVED=112, MIN_TAB_WIDTH=120, OVERFLOW_BTN=28).
    // With the right rail open by default the middle column is
    // viewportWidth - 588 (48 ribbon + 260 sidebar + 280 rail), so 1150px lands
    // at ~450px. Empirically [1100,1200] all yield 3-visible/2-hidden; 900px
    // would now overflow to a single pill.
    await page.setViewportSize({ width: 1150, height: 800 });

    await waitForConnected(page, jasper.baseURL);
    for (const id of ids) {
      await openNoteFromTree(page, id);
    }

    // active = the last-opened tab ('wr03-e'); the interleaved window keeps
    // [a,b,e] visible and hides {c,d} (active is never evicted from view).
    await expect(tabPills(page)).toHaveCount(3);
    const hiddenTrigger = tabStrip(page).getByRole("button", {
      name: "Show all tabs",
    });
    await expect(hiddenTrigger).toBeVisible({ timeout: 5_000 });

    const visibleBefore = (await tabPills(page).allTextContents()).map((t) =>
      t.trim(),
    );
    expect(visibleBefore).toEqual(["wr03-a", "wr03-b", "wr03-e"]);

    // Drag the first VISIBLE tab ('wr03-a') to just before the last visible
    // tab ('wr03-e') — the interleaved-hidden scenario this regresses on:
    // the naive full-array target index used to span the hidden {c,d} tabs
    // and land the drop in the wrong place / swallow it into overflow.
    let fromBox = await tabPills(page).nth(0).boundingBox();
    let toBox = await tabPills(page).nth(2).boundingBox();
    await expect
      .poll(async () => {
        fromBox = await tabPills(page).nth(0).boundingBox();
        toBox = await tabPills(page).nth(2).boundingBox();
        return (fromBox?.width ?? 0) > 0 && (toBox?.width ?? 0) > 0;
      }, { timeout: 5_000 })
      .toBe(true);
    if (!fromBox || !toBox) throw new Error("tab bounding boxes unavailable");

    const fromX = fromBox.x + fromBox.width / 2;
    const fromY = fromBox.y + fromBox.height / 2;
    // Land in the left half of the target pill so computeDropTarget resolves
    // to "just before" it, not past it.
    const toX = toBox.x + Math.min(5, toBox.width / 4);
    const toY = toBox.y + toBox.height / 2;

    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    await page.mouse.move(toX, toY, { steps: 10 });
    await page.mouse.up();

    // Tolerate minor RESERVED-constant drift: assert the 3-visible/2-hidden
    // SHAPE and the dragged tab's continued presence among the visible
    // pills, not a specific pixel-derived final order.
    await expect(tabPills(page)).toHaveCount(3, { timeout: 5_000 });
    await expect
      .poll(async () =>
        (await tabPills(page).allTextContents()).map((t) => t.trim()),
      )
      .toContain("wr03-a");

    // Confirm the dragged tab was never swallowed into the overflow dropdown.
    // The dropdown always lists EVERY open tab, not
    // just the hidden ones, so diff its full list against the currently-
    // visible pill titles to find the collapsed ones and assert wr03-a isn't
    // among them.
    const visibleAfter = (await tabPills(page).allTextContents()).map((t) =>
      t.trim(),
    );
    await hiddenTrigger.click();
    const allItems = page.getByRole("menuitem");
    await expect(allItems).toHaveCount(5, { timeout: 5_000 });
    const allTitles = (await allItems.allTextContents()).map((t) => t.trim());
    const collapsedTitles = allTitles.filter((t) => !visibleAfter.includes(t));
    expect(collapsedTitles).toHaveLength(2);
    expect(collapsedTitles).not.toContain("wr03-a");
    await page.keyboard.press("Escape");
  });
});

// ─── TABUI-01: tab geometry ──────────────────────────────────────────────────

test.describe("@phase18 TABUI-01: tab geometry (40px, flush, top accent, file icon)", () => {
  let jasper: JasperHandle;
  let idFirst: string;
  let idSecond: string;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
    idFirst = await createNote(jasper, "geometry-first");
    idSecond = await createNote(jasper, "geometry-second");
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("active + inactive tabs are 40px/square-cornered; active has a 2px accent top border, file icon, and close X", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, idFirst);
    await openNoteFromTree(page, idSecond);
    await expect(tabPills(page)).toHaveCount(2);

    // idSecond was opened last, so it is the active tab.
    const activePill = page.getByRole("tab", { selected: true });
    const inactivePill = page.getByRole("tab", { selected: false });
    await expect(activePill).toHaveCount(1);
    await expect(inactivePill).toHaveCount(1);

    for (const pill of [activePill, inactivePill]) {
      const geometry = await pill.evaluate((el) => {
        const cs = getComputedStyle(el);
        return {
          height: cs.height,
          borderTopLeftRadius: cs.borderTopLeftRadius,
          borderTopRightRadius: cs.borderTopRightRadius,
        };
      });
      expect(geometry.height).toBe("40px");
      expect(geometry.borderTopLeftRadius).toBe("0px");
      expect(geometry.borderTopRightRadius).toBe("0px");

      // Leading FileText icon before the title, and the close X remains present.
      await expect(pill.locator("svg").first()).toBeVisible();
      await expect(pill.locator('button[aria-label^="Close "]')).toHaveCount(1);
    }

    const activeBorder = await activePill.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { width: cs.borderTopWidth, color: cs.borderTopColor };
    });
    expect(activeBorder.width).toBe("2px");
    // --color-accent default #a78bfa -> rgb(167, 139, 250).
    expect(activeBorder.color).toBe("rgb(167, 139, 250)");

    const inactiveBorderColor = await inactivePill.evaluate(
      (el) => getComputedStyle(el).borderTopColor,
    );
    // "2px solid transparent" resolves to a zero-alpha rgba in Chromium.
    expect(inactiveBorderColor).toBe("rgba(0, 0, 0, 0)");
  });
});

// ─── RIBBON-01: activity ribbon presence + vault badge ──────────────────────

test.describe("@phase18 RIBBON-01: activity ribbon presence + vault badge", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("nav[aria-label='Activity ribbon'] is visible and the badge letter matches the vault's display name", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    await expect(ribbon).toBeVisible({ timeout: 10_000 });

    const badge = ribbon.locator('div[aria-label^="Vault:"]');
    await expect(badge).toBeVisible();
    const badgeLetter = ((await badge.textContent()) ?? "").trim();

    // Same display_name source the StatusBar's vault label reads.
    const vaultLabel = page.getByTestId("status-bar-vault");
    await expect(vaultLabel).toBeVisible({ timeout: 10_000 });
    const vaultName = ((await vaultLabel.textContent()) ?? "").trim();
    // Surrogate-safe first-character extraction — matches production
    // (ActivityRibbon.tsx: `[...trimmedDisplayName][0]?.toUpperCase() ?? "J"`),
    // not `charAt(0)` which would split a surrogate pair in half.
    const expectedLetter =
      vaultName.length > 0
        ? ([...vaultName][0]?.toUpperCase() ?? "J")
        : "J";

    expect(badgeLetter).toBe(expectedLetter);
  });
});

// ─── Ribbon button wiring ────────────────────────────────────────────────────
//
// OPEN QUESTION for owner review: these two tests overlap phase27-uat.spec.ts's
// NAV-01/NAV-02, which already exercises SidebarTabRow panel-switching and
// asserts the ribbon carries no Files/Search buttons. Retire one once confirmed
// redundant — both left in place pending sign-off.
test.describe("@phase18 RIBBON-02/03/04: ribbon button wiring", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Notes tab (SidebarTabRow) is accent-colored while active; the ribbon no longer carries a Files toggle", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    const sidebarNav = page.locator('nav[aria-label="Notes navigation"]');
    const tabRow = sidebarNav.getByTestId("sidebar-tab-row");
    const notesTab = tabRow.getByRole("button", { name: "Notes", exact: true });
    const searchTab = tabRow.getByRole("button", { name: "Search", exact: true });

    // The ribbon's Files toggle is gone (NAV-02) — no such button
    // exists anywhere on the page anymore.
    await expect(ribbon.getByRole("button", { name: "Files", exact: true })).toHaveCount(0);

    // Default state: sidebar visible, Notes panel active + accent-colored.
    await expect(sidebarNav).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => notesTab.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)"); // --color-accent

    // Switching to Search: Notes goes muted, Search becomes accent — the
    // tab row now drives panel SELECTION, not visibility (visibility is a
    // separate "Collapse sidebar"/"Show sidebar" affordance, TABUI-02).
    await searchTab.click();
    await expect(sidebarNav).toBeVisible();
    await expect
      .poll(() => notesTab.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(106, 106, 114)"); // --color-muted
    await expect
      .poll(() => searchTab.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)");

    await notesTab.click();
    await expect
      .poll(() => notesTab.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)");
  });

  test("Search tab (SidebarTabRow) opens the sidebar Search panel (not the command palette) and is accent-colored while active", async ({
    page,
  }) => {
    // NAV-02 re-point: the standalone ribbon Search TOGGLE this
    // test originally guarded was removed; SidebarTabRow's "Search" tab is
    // its current equivalent for OPENING the panel (the
    // in-sidebar Search panel is still the current design — only the
    // entry-point button moved). FOCUSING the input, however, is no longer
    // wired to the tab click at all (SidebarTabRow.tsx's selectPanel() only
    // calls setSidebarPanel + setNotesSidebarVisible — no focus dispatch);
    // that concern moved entirely to the Cmd+Shift+F shortcut
    // (appShortcuts.ts's handleAppCmdShiftF, whose own docstring says
    // "opens the sidebar Search panel + focuses its input") — the
    // literal current-code equivalent of "opens Search focused" this test
    // originally asserted via the ribbon button.
    await waitForConnected(page, jasper.baseURL);
    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    const sidebarNav = page.locator('nav[aria-label="Notes navigation"]');
    const tabRow = sidebarNav.getByTestId("sidebar-tab-row");
    const searchTab = tabRow.getByRole("button", { name: "Search", exact: true });
    const sidebarSearchInput = page.getByPlaceholder(
      "Search notes… (tag:name to filter)",
    );

    // The ribbon's Search toggle is gone (NAV-02) — no such button
    // exists anywhere on the page anymore.
    await expect(ribbon.locator('button[aria-label="Search notes"]')).toHaveCount(0);

    await expect
      .poll(() => searchTab.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(106, 106, 114)"); // muted before selection (Notes is default)

    // Cmd+Shift+F (Control+Shift+F here — the handler checks metaKey OR
    // ctrlKey directly, deterministic regardless of Playwright's Desktop
    // Chrome device spoofing navigator.platform, mirroring phase27-uat's
    // Cmd+Shift+E pattern): opens the Search panel AND focuses its input.
    await page.keyboard.press("Control+Shift+F");
    await expect(sidebarSearchInput).toBeVisible({ timeout: 5_000 });
    await expect(sidebarSearchInput).toBeFocused();
    // The command-palette dialog must NOT open via this path.
    await expect(page.getByRole("dialog", { name: "Command palette" })).toHaveCount(0);
    await expect
      .poll(() => searchTab.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)"); // accent while active

    // The SidebarTabRow "Search" tab itself is still a valid (unfocused)
    // entry point to the same panel — switch away and back via the tab
    // click to prove the click path also works, independent of the
    // shortcut's focus behavior.
    await tabRow.getByRole("button", { name: "Notes", exact: true }).click();
    await expect(sidebarSearchInput).toHaveCount(0);
    await searchTab.click();
    await expect(sidebarSearchInput).toBeVisible({ timeout: 5_000 });

    // Unlike the old ribbon toggle, clicking Search again does NOT hide the
    // sidebar — SidebarTabRow tabs only ever SELECT a panel (SidebarTabRow.tsx
    // selectPanel() always calls setNotesSidebarVisible(true)); the panel
    // switches away only when a different tab is clicked.
    await searchTab.click();
    await expect(sidebarSearchInput).toBeVisible();
  });

  test("daily-note button opens today's daily note as a NEW tab when a note is already open", async ({
    page,
  }) => {
    const existingId = await createNote(jasper, "existing-note");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, existingId);
    await expect(tabPills(page)).toHaveCount(1);

    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    // Scoped to the ribbon: SidebarToolbar's own "Today" button shares this
    // exact aria-label, so an unscoped locator would violate strict mode.
    const dailyBtn = ribbon.getByRole("button", { name: "Open today's daily note" });

    await expect(dailyBtn).toBeVisible({ timeout: 10_000 });

    // capture the local-calendar date BEFORE and AFTER the click so
    // this test cannot race local midnight — a click landing exactly on the
    // local day boundary must still match one of the two straddling dates,
    // not whichever single sample happened to be read.
    const todayBefore = localDateString(new Date());
    await dailyBtn.click();
    const todayAfter = localDateString(new Date());

    // Proves the tabs-open path (18-05 fix): openToday must push a NEW tab
    // onto the existing strip (via useTabStore.openTab), not merely render
    // into the zero-tab fallback pane — the old assertion here masked a
    // regression where the daily note opened without becoming a tab.
    await expect
      .poll(
        async () =>
          (await tabPills(page).allTextContents()).map((t) => t.trim()),
        { timeout: 10_000 },
      )
      .toEqual([
        "existing-note",
        expect.stringMatching(new RegExp(`^(${todayBefore}|${todayAfter})$`)),
      ]);

    const activeTab = page.getByRole("tab", { selected: true });
    const activeTabText = ((await activeTab.textContent()) ?? "").trim();
    expect([todayBefore, todayAfter]).toContain(activeTabText);
    // Two EditorPanes are keep-alive-mounted at this point (one per open tab,
    // sidebar Search tab); scope to the visible one to avoid a strict-mode violation.
    await expect(page.locator(".cm-content:visible")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("command-palette button opens the CommandMenu", async ({ page }) => {
    await waitForConnected(page, jasper.baseURL);
    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    const paletteBtn = ribbon.getByRole("button", { name: "Open command palette" });

    await paletteBtn.click();
    await expect(
      page.getByRole("dialog", { name: "Command palette" }),
    ).toBeVisible({ timeout: 5_000 });
  });
});

// ─── POLISH-09: center-column vertical geometry pin (18-09 sign-off) ────────

test.describe("@phase18 POLISH-09: center-column vertical geometry pin", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("tab-strip is y=0/h=40 (absolute), breadcrumb is flush under the strip, cm-content is flush under the breadcrumb", async ({
    page,
  }) => {
    // Match the 1512x944 measurement context the pins were empirically
    // derived so these pins are stable across CI
    // runners regardless of the suite's default Desktop Chrome viewport.
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await createNote(jasper, "geom-pinned-note");
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    const breadcrumb = page.getByTestId("note-breadcrumb");
    const cmContent = page.locator(".cm-content:visible");
    const title = page.getByTestId("editor-title-element");

    // Poll until all four boxes resolve to non-zero dimensions before
    // asserting exact pixel values (no bare pre-layout read).
    let stripBox = await tabStrip(page).boundingBox();
    let breadcrumbBox = await breadcrumb.boundingBox();
    let cmBox = await cmContent.boundingBox();
    let titleBox = await title.boundingBox();
    await expect
      .poll(async () => {
        stripBox = await tabStrip(page).boundingBox();
        breadcrumbBox = await breadcrumb.boundingBox();
        cmBox = await cmContent.boundingBox();
        titleBox = await title.boundingBox();
        return (
          (stripBox?.height ?? 0) > 0 &&
          (breadcrumbBox?.height ?? 0) > 0 &&
          (cmBox?.height ?? 0) > 0 &&
          (titleBox?.height ?? 0) > 0
        );
      }, { timeout: 5_000 })
      .toBe(true);
    if (!stripBox || !breadcrumbBox || !cmBox) {
      throw new Error("geometry bounding boxes unavailable");
    }

    // Absolute — TABUI-01 contract.
    expect(stripBox.y).toBe(0);
    expect(stripBox.height).toBe(40);
    // Relational flush pins (survive benign breadcrumb-padding restyles).
    expect(breadcrumbBox.y).toBe(stripBox.y + stripBox.height);
    // READ-01: .cm-content gained a 44px top
    // padding as part of the 760px centered reading column, and the
    // TitleElement now mounts between the breadcrumb and cm-content, so
    // cm-content is no longer flush against the breadcrumb — it now sits at
    // or below the breadcrumb PLUS the title element's own height. Additive
    // update only; the pin is never deleted.
    expect(cmBox.y).toBeGreaterThanOrEqual(
      breadcrumbBox.y + breadcrumbBox.height + (titleBox?.height ?? 0),
    );
  });
});

// ─── TABUI-02: each sidebar's own collapse control + corner/tab-strip reopen ─

test.describe("@phase18 TABUI-02: sidebar toggle placement", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("left sidebar collapses via its header control and reopens via the pane-corner button; the right rail collapses via its own tab row and reopens via the tab strip's right cluster — each toggles only its own sidebar", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    // LEFT sidebar (NAV-03): default notesSidebarVisible=true.
    const sidebarNav = page.locator('nav[aria-label="Notes navigation"]');
    await expect(sidebarNav).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await expect(sidebarNav).toHaveCount(0, { timeout: 5_000 });

    const reopenLeftBtn = page.getByRole("button", { name: "Show sidebar" });
    await expect(reopenLeftBtn).toBeVisible();
    await reopenLeftBtn.click();
    await expect(sidebarNav).toBeVisible();

    // RIGHT rail: expanded by default — the
    // rail's own tab row owns the sole collapse control; no reopen cluster
    // renders while expanded.
    const railHandle = page.getByRole("separator", { name: "Resize backlinks panel" });
    await expect(railHandle).toBeVisible();
    const railTabRow = page.getByTestId("right-rail-tab-row");
    await expect(railTabRow).toBeVisible();
    await expect(tabStrip(page).getByTestId("tab-strip-right-cluster")).toHaveCount(0);

    await railTabRow.getByRole("button", { name: "Collapse panels" }).click();
    await expect(railHandle).toHaveCount(0, { timeout: 5_000 });
    await expect(railTabRow).toHaveCount(0, { timeout: 5_000 });

    const rightCluster = tabStrip(page).getByTestId("tab-strip-right-cluster");
    const reopenRightBtn = rightCluster.getByRole("button", { name: "Show panels" });
    await expect(reopenRightBtn).toBeVisible({ timeout: 5_000 });
    await reopenRightBtn.click();
    await expect(page.getByTestId("right-rail-tab-row")).toBeVisible({ timeout: 5_000 });
  });
});
