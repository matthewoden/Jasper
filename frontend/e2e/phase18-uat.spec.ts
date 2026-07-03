/**
 * Phase 18 UAT — Activity Ribbon & Chrome Shell.
 *
 * D-05 (regression gate): the tab-bar restyle (TABUI-01) touches every pixel
 *   value the pointer-drag math (`computeDropTarget`, wrapper
 *   `getBoundingClientRect`) depends on indirectly via layout. This spec
 *   proves — with real `page.mouse` against a rebuilt binary, never synthetic
 *   DragEvents (memory `verify-dnd-with-real-mouse`) — that drag-reorder, the
 *   cursor-following ghost, and the insertion indicator all still work.
 * TABUI-01: tabs are 40px tall, square-cornered (no border-radius), each has
 *   a leading file icon + a close X, and the active tab shows a 2px accent
 *   TOP border (moved from the old bottom-border position).
 * RIBBON-01..04: the 48px activity ribbon renders with the vault-initial
 *   badge, and its Files/Search/daily-note/command-palette buttons drive
 *   their already-shipped actions.
 * TABUI-02: the left/right sidebar toggles live in the tab-bar's right-hand
 *   cluster (relocated from the now-dissolved ChromeBar) and toggle their
 *   respective sidebars.
 *
 * Harness mirrors phase17-uat.spec.ts: spawnJasper per describe block,
 * beforeAll/afterAll. Every binary-backed describe gets its own ephemeral
 * vault (spawnJasper's default dataDir), so tests never share mutable server
 * state across describes; Playwright's per-test browsing context means
 * client-side (localStorage/Zustand) state also resets between tests within
 * the same describe.
 *
 * Discipline: ZERO fixed sleeps. Every timing-sensitive step uses a web-first
 * assertion (expect / expect.poll).
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

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

function noteRow(page: Page, id: string) {
  return page.locator(`[data-tree-row="${id}"][data-tree-row-kind="note"]`);
}

/** Open a tree note by clicking its row; waits for the row to be visible first. */
async function openNoteFromTree(page: Page, id: string): Promise<void> {
  const row = noteRow(page, id);
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();
}

// ─── D-05: DnD regression — drag-reorder, ghost, drop indicator ─────────────

test.describe("@phase18 D-05: DnD regression — drag/ghost/drop-indicator survive the restyle", () => {
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

    // Same display_name source the StatusBar's vault label reads (D-06).
    const vaultLabel = page.getByTestId("status-bar-vault");
    await expect(vaultLabel).toBeVisible({ timeout: 10_000 });
    const vaultName = ((await vaultLabel.textContent()) ?? "").trim();
    const expectedLetter =
      vaultName.length > 0 ? vaultName.charAt(0).toUpperCase() : "J";

    expect(badgeLetter).toBe(expectedLetter);
  });
});

// ─── RIBBON-02/03/04: ribbon button wiring ───────────────────────────────────

test.describe("@phase18 RIBBON-02/03/04: ribbon button wiring", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("Files toggle drives notes-sidebar visibility and is accent-colored while the sidebar is visible", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    const filesBtn = ribbon.getByRole("button", { name: "Files" });
    const sidebarNav = page.locator('nav[aria-label="Notes navigation"]');

    // Default state: notesSidebarVisible === true.
    await expect(sidebarNav).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => filesBtn.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)"); // --color-accent

    await filesBtn.click();
    await expect(sidebarNav).toHaveCount(0, { timeout: 5_000 });
    await expect
      .poll(() => filesBtn.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(106, 106, 114)"); // --color-muted

    await filesBtn.click();
    await expect(sidebarNav).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(() => filesBtn.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)");
  });

  test("Search toggle opens the search palette and is accent-colored while it is open", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);
    const ribbon = page.locator('nav[aria-label="Activity ribbon"]');
    // Attribute selector (not getByRole): Radix Dialog marks background
    // content aria-hidden while open, which would make a role-based locator
    // stop resolving the button once the dialog opens.
    const searchBtn = ribbon.locator('button[aria-label="Search notes (⌘⇧F)"]');

    await expect
      .poll(() => searchBtn.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(106, 106, 114)"); // muted before open

    await searchBtn.click();
    const dialog = page.getByRole("dialog", { name: "Search notes" });
    await expect(dialog).toBeVisible({ timeout: 5_000 });
    await expect
      .poll(() => searchBtn.evaluate((el) => getComputedStyle(el).color))
      .toBe("rgb(167, 139, 250)"); // accent while open

    await page.keyboard.press("Escape");
    await expect(dialog).not.toBeVisible({ timeout: 3_000 });
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
    await dailyBtn.click();

    // Proves the tabs-open path (18-05 fix): openToday must push a NEW tab
    // onto the existing strip (via useTabStore.openTab), not merely render
    // into the zero-tab fallback pane — the old assertion here masked a
    // regression where the daily note opened without becoming a tab.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    await expect
      .poll(
        async () =>
          (await tabPills(page).allTextContents()).map((t) => t.trim()),
        { timeout: 10_000 },
      )
      .toEqual(["existing-note", today]);

    const activeTab = page.getByRole("tab", { selected: true });
    await expect(activeTab).toHaveText(today);
    // Two EditorPanes are keep-alive-mounted at this point (one per open tab,
    // D-01); scope to the visible one to avoid a strict-mode violation.
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

// ─── TABUI-02: tab-bar split toggle placement (far-left / far-right) ────────

test.describe("@phase18 TABUI-02: tab-bar split toggle placement", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("left-sidebar toggle sits in the far-left cluster, right-sidebar toggle in the far-right cluster, and each toggles its own sidebar", async ({
    page,
  }) => {
    await waitForConnected(page, jasper.baseURL);

    // Owner revision (2026-07-02, gap 3): the toggles are SPLIT, not
    // co-located in a single right-hand cluster — left toggle far-left,
    // right toggle far-right, superseding CONTEXT D-04.
    const leftCluster = tabStrip(page).getByTestId("tab-strip-left-cluster");
    const rightCluster = tabStrip(page).getByTestId("tab-strip-right-cluster");
    await expect(leftCluster).toBeVisible({ timeout: 10_000 });
    await expect(rightCluster).toBeVisible({ timeout: 10_000 });

    // Default states: notesSidebarVisible=true, backlinksRailExpanded=false.
    const leftToggle = leftCluster.getByRole("button", { name: "Hide notes sidebar" });
    const rightToggle = rightCluster.getByRole("button", { name: "Show panels" });
    await expect(leftToggle).toBeVisible();
    await expect(rightToggle).toBeVisible();

    const sidebarNav = page.locator('nav[aria-label="Notes navigation"]');
    await expect(sidebarNav).toBeVisible();
    await leftToggle.click();
    await expect(sidebarNav).toHaveCount(0, { timeout: 5_000 });
    await expect(
      leftCluster.getByRole("button", { name: "Show notes sidebar" }),
    ).toBeVisible();

    // The right toggle expands the backlinks/tags rail — its resize handle
    // only renders while the rail is expanded (RightRail returns null otherwise).
    const railHandle = page.getByRole("separator", { name: "Resize backlinks panel" });
    await expect(railHandle).toHaveCount(0);
    await rightToggle.click();
    await expect(railHandle).toBeVisible({ timeout: 5_000 });
    await expect(
      rightCluster.getByRole("button", { name: "Hide panels" }),
    ).toBeVisible();
  });
});
