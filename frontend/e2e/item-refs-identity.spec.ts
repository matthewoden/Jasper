/**
 * Note identity lives in the file. These scenarios drive the binary the way
 * a user and an external tool would and check both ends: what the API says
 * and what is on disk.
 */
import { test, expect, type Page } from "@playwright/test";
import { readFile, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const ID_LINE_RE = /^---\nid: ([0-9A-HJKMNP-TV-Z]{26})\n/;

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});

async function connect(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

async function apiCreateNote(page: Page, title: string): Promise<{ id: string; path: string }> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { parent_path: "", title },
  });
  expect(resp.status()).toBe(201);
  return (await resp.json()) as { id: string; path: string };
}

async function apiGetNote(page: Page, id: string): Promise<{ content: string; etag: string; path: string }> {
  const resp = await page.request.get(`${jasper.baseURL}/api/v1/notes/${id}`);
  expect(resp.status()).toBe(200);
  return (await resp.json()) as { content: string; etag: string; path: string };
}

async function apiTreeNoteIds(page: Page): Promise<Map<string, string>> {
  const resp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
  expect(resp.status()).toBe(200);
  const tree = (await resp.json()) as { root: Array<{ kind: string; id?: string; path?: string }> };
  const out = new Map<string, string>();
  for (const n of tree.root) if (n.kind === "note" && n.id && n.path) out.set(n.path, n.id);
  return out;
}

async function apiReindex(page: Page, mode: "incremental" | "full"): Promise<void> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/admin/reindex`, { data: { mode } });
  expect(resp.status()).toBe(202);
}

function notePath(rel: string): string {
  return path.join(jasper.dataDir, "notes", rel);
}

test.describe("@item-refs identity", () => {
  test("a created note carries its id in the file, and the id survives a full rebuild", async ({ page }) => {
    await connect(page);
    const created = await apiCreateNote(page, "identity-alpha");
    expect(created.id).toMatch(ULID_RE);

    const onDisk = await readFile(notePath(created.path), "utf8");
    expect(onDisk.match(ID_LINE_RE)?.[1]).toBe(created.id);

    const before = await apiTreeNoteIds(page);
    await apiReindex(page, "full");
    await expect.poll(async () => (await apiTreeNoteIds(page)).size).toBe(before.size);
    expect(await apiTreeNoteIds(page)).toEqual(before);
    expect(await readFile(notePath(created.path), "utf8")).toBe(onDisk);
  });

  test("a note dropped into notes/ by hand is given an id on refresh, and nothing else changes", async ({ page }) => {
    await connect(page);
    const body = "---\ntags: [outside]\n---\n\n# Dropped in\n\nWritten by another tool.\n";
    await writeFile(notePath("dropped-in.md"), body, "utf8");

    await apiReindex(page, "incremental");
    await expect.poll(async () => (await apiTreeNoteIds(page)).get("dropped-in.md")).toMatch(ULID_RE);
    const id = (await apiTreeNoteIds(page)).get("dropped-in.md")!;

    const after = await readFile(notePath("dropped-in.md"), "utf8");
    expect(after).toBe(`---\nid: ${id}\ntags: [outside]\n---\n\n# Dropped in\n\nWritten by another tool.\n`);
    expect((await apiGetNote(page, id)).content).toBe(after);
  });

  test("a clean open tab picks up the id reconcile wrote and keeps saving without a conflict", async ({ page }) => {
    await connect(page);
    const created = await apiCreateNote(page, "identity-open");
    await openNoteFromTree(page, created.id);
    await page.waitForSelector(".cm-content", { timeout: 5_000 });
    const staleEtag = (await apiGetNote(page, created.id)).etag;

    // An external tool strips the id line. Change detection is mtime-only at
    // second granularity, so the edit is dated past the create.
    const stripped = (await readFile(notePath(created.path), "utf8")).replace(/^---\nid: [^\n]+\n/, "---\n");
    await writeFile(notePath(created.path), stripped, "utf8");
    const later = new Date(Date.now() + 5_000);
    await utimes(notePath(created.path), later, later);
    await apiReindex(page, "incremental");

    // Reconcile put the id back, which is a new version of the file.
    await expect.poll(
      async () => (await apiGetNote(page, created.id)).content.match(ID_LINE_RE)?.[1],
    ).toBe(created.id);
    expect((await apiGetNote(page, created.id)).etag).not.toBe(staleEtag);

    // The tab was clean, so it re-read the note; its next save carries the
    // current comparator and lands.
    await page.locator(".cm-content").click();
    await page.keyboard.press("End");
    await page.keyboard.type(" typed after refresh");
    await expect.poll(
      async () => (await apiGetNote(page, created.id)).content,
      { timeout: 10_000 },
    ).toContain("typed after refresh");
    await expect(page.getByTestId("conflict-banner")).toHaveCount(0);
    expect((await apiGetNote(page, created.id)).content.match(ID_LINE_RE)?.[1]).toBe(created.id);
  });

  test("a bookmark written with the old id format recovers through its path", async ({ page }) => {
    await connect(page);
    const created = await apiCreateNote(page, "identity-bookmarked");

    // restart() keeps the vault directory; kill() would remove it.
    const bookmarksPath = path.join(jasper.dataDir, ".jasper", "bookmarks.json");
    await writeFile(
      bookmarksPath,
      JSON.stringify({
        folders: [],
        bookmarks: [
          { id: "11111111-1111-4111-8111-111111111111", noteId: "00000000-0000-4000-a000-000000000123", folderId: null, order: 0, path: created.path },
        ],
      }),
      "utf8",
    );
    jasper = await jasper.restart();

    const resp = await page.request.get(`${jasper.baseURL}/api/v1/bookmarks`);
    expect(resp.status()).toBe(200);
    const doc = (await resp.json()) as { bookmarks: Array<{ note_id: string }> };
    expect(doc.bookmarks.map((b) => b.note_id)).toEqual([created.id]);
  });
});
