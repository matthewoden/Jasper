/**
 * The conflict-safety scenario the WebSocket channel structurally cannot cover.
 *
 * phase4-uat's Scenario 2 proves the banner appears when tab B *receives* a
 * note:updated event. This file proves the opposite case: B never gets the
 * event, so nothing in the client knows a conflict exists. Only the comparator
 * on the wire can catch it.
 *
 * Before If-Match was threaded through every save, B's next save wrote
 * unconditionally and silently destroyed A's content — the entire optimistic-
 * locking machinery bypassed on the one path that needed it.
 *
 * Two ways of producing B's blindness are used. Most tests drop note:updated at
 * B's socket, which reproduces the state under test — stale content, local
 * edits, no knowledge of A's write — with no timing coupling at all. The last
 * test drops the socket for real and waits out the app's jittered backoff, so
 * the reconnect-flush path itself is covered rather than assumed. Note that
 * setOffline is no use for either: it does not close an already-open socket.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});

/**
 * Make every socket in this context deaf to note:updated once
 * window.__jasperDropNoteEvents is set. Patches the onmessage setter on
 * WebSocket.prototype, which is the assignment form useSessionSync uses.
 */
async function makeContextMissNoteEvents(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const proto = WebSocket.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
    if (!desc?.set || !desc.get) return;
    const originalSet = desc.set;
    const originalGet = desc.get;
    Object.defineProperty(proto, "onmessage", {
      configurable: true,
      get(this: WebSocket) {
        return originalGet.call(this);
      },
      set(this: WebSocket, fn: ((e: MessageEvent) => void) | null) {
        if (fn === null) {
          originalSet.call(this, null);
          return;
        }
        originalSet.call(this, (event: MessageEvent) => {
          if ((window as unknown as Record<string, boolean>).__jasperDropNoteEvents) {
            try {
              const env = JSON.parse(event.data as string) as { event?: string };
              if (env.event === "note:updated") return;
            } catch {
              // Unparseable frames fall through to the app untouched.
            }
          }
          fn(event);
        });
      },
    });
  });
}

async function openTabInContext(
  ctx: BrowserContext,
  baseURL: string,
): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
  return page;
}

async function openFirstNote(page: Page): Promise<void> {
  const firstNote = page.locator('[data-tree-row-kind="note"]').first();
  await firstNote.click();
  await page.waitForSelector(".cm-content", { timeout: 5_000 });
}

/** The path of the note openFirstNote lands on — read from the API, not the DOM. */
async function firstNotePath(page: Page): Promise<string> {
  const resp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
  expect(resp.status()).toBe(200);
  const tree = (await resp.json()) as {
    root: Array<{ kind: string; path?: string }>;
  };
  const note = tree.root.find((n) => n.kind === "note");
  if (!note?.path) throw new Error("no note at tree root");
  return note.path;
}

/**
 * Let this context's sockets be dropped and held down on demand.
 *
 * window.__jasperBlockWS closes each new socket as it opens, so the app keeps
 * retrying instead of succeeding; clearing it lets the next attempt through.
 */
async function makeContextDroppable(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    const Native = window.WebSocket;
    class Droppable extends Native {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        const w = window as unknown as Record<string, unknown>;
        (w.__jasperSockets as WebSocket[]).push(this);
        if (w.__jasperBlockWS) {
          this.addEventListener("open", () => this.close());
        }
      }
    }
    const w = window as unknown as Record<string, unknown>;
    w.__jasperSockets = [];
    w.__jasperBlockWS = false;
    window.WebSocket = Droppable as unknown as typeof WebSocket;
  });
}

async function dropSocketsAndHoldDown(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__jasperBlockWS = true;
    for (const s of w.__jasperSockets as WebSocket[]) s.close();
  });
  await expect(page.getByTestId("connection-status-dot")).not.toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 15_000 },
  );
}

async function allowReconnect(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as Record<string, unknown>).__jasperBlockWS = false;
  });
  // The app's backoff is jittered and caps at 30s; a handful of blocked
  // attempts can push the next one out several seconds.
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 60_000 },
  );
}

/** .fill() is a no-op on contenteditable, so CM6 needs click → select-all → type. */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  const cm = page.locator(".cm-content");
  await cm.click();
  const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

async function saveNow(page: Page): Promise<void> {
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+s" : "Control+s",
  );
}

async function readNoteOnDisk(notePath: string): Promise<string> {
  return await readFile(path.join(jasper.dataDir, "notes", notePath), "utf8");
}

test.describe("conflict safety — every save carries If-Match", () => {
  test("B misses A's update and saves anyway → banner, and A's content survives on disk", async ({
    browser,
  }) => {
    // Separate contexts so the tabs get independent session_ids, which is what
    // makes the server's origin filtering real rather than incidental.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await makeContextMissNoteEvents(ctxB);
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await openFirstNote(pageA);
      await openFirstNote(pageB);
      const notePath = await firstNotePath(pageA);

      await pageB.evaluate(() => {
        (window as unknown as Record<string, boolean>).__jasperDropNoteEvents = true;
      });

      const aContent = "Tab A content that must survive";
      await typeIntoEditor(pageA, aContent);
      await saveNow(pageA);
      await expect
        .poll(() => readNoteOnDisk(notePath), { timeout: 10_000 })
        .toContain(aContent);

      // B is blind to the write above, so nothing client-side can warn it.
      await expect(pageB.getByTestId("conflict-banner")).toHaveCount(0);

      await typeIntoEditor(pageB, "Tab B stale edit");
      await saveNow(pageB);

      await expect(pageB.getByTestId("conflict-banner")).toBeVisible({
        timeout: 10_000,
      });

      const onDisk = await readNoteOnDisk(notePath);
      expect(onDisk).toContain(aContent);
      expect(onDisk).not.toContain("Tab B stale edit");
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });

  test("Save anyway commits B's content and leaves the next autosave working", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await makeContextMissNoteEvents(ctxB);
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await openFirstNote(pageA);
      await openFirstNote(pageB);
      const notePath = await firstNotePath(pageA);

      await pageB.evaluate(() => {
        (window as unknown as Record<string, boolean>).__jasperDropNoteEvents = true;
      });

      await typeIntoEditor(pageA, "Tab A content v1");
      await saveNow(pageA);
      await expect
        .poll(() => readNoteOnDisk(notePath), { timeout: 10_000 })
        .toContain("Tab A content v1");

      await typeIntoEditor(pageB, "Tab B deliberate overwrite");
      await saveNow(pageB);

      const banner = pageB.getByTestId("conflict-banner");
      await expect(banner).toBeVisible({ timeout: 10_000 });
      await pageB.getByRole("button", { name: /save anyway/i }).click();
      await expect(banner).toBeHidden({ timeout: 10_000 });

      await expect
        .poll(() => readNoteOnDisk(notePath), { timeout: 10_000 })
        .toContain("Tab B deliberate overwrite");

      // The regression this guards: if Save-anyway does not hand its new token
      // back to the controller, every later save 409s against the write the
      // user just authorized, and the banner comes back forever.
      await typeIntoEditor(pageB, "Tab B follow-up edit");
      await saveNow(pageB);
      await expect
        .poll(() => readNoteOnDisk(notePath), { timeout: 10_000 })
        .toContain("Tab B follow-up edit");
      await expect(banner).toBeHidden();
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
  /**
   * The literal scenario from the ticket: B's socket really goes down, A saves
   * during the gap, and B's reconnect-flush is the first thing to reach the
   * server. Slower than the two above because it waits on the app's real
   * jittered backoff, which is why it is one test rather than the pattern.
   */
  test("B's socket drops, A saves, B's reconnect-flush is refused rather than silently winning", async ({
    browser,
  }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    await makeContextDroppable(ctxB);
    const pageA = await openTabInContext(ctxA, jasper.baseURL);
    const pageB = await openTabInContext(ctxB, jasper.baseURL);

    try {
      await openFirstNote(pageA);
      await openFirstNote(pageB);
      const notePath = await firstNotePath(pageA);

      // While B is disconnected its save gate is shut, so nothing it types can
      // reach the server until the reconnect-flush fires. That is what makes
      // the ordering below deterministic rather than a race with autosave.
      await dropSocketsAndHoldDown(pageB);

      const aContent = "Tab A wrote this during B's outage";
      await typeIntoEditor(pageA, aContent);
      await saveNow(pageA);
      await expect
        .poll(() => readNoteOnDisk(notePath), { timeout: 10_000 })
        .toContain(aContent);

      await typeIntoEditor(pageB, "Tab B offline edit");

      await allowReconnect(pageB);

      await expect(pageB.getByTestId("conflict-banner")).toBeVisible({
        timeout: 20_000,
      });

      const onDisk = await readNoteOnDisk(notePath);
      expect(onDisk).toContain(aContent);
      expect(onDisk).not.toContain("Tab B offline edit");
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
