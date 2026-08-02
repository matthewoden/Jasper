/**
 * Every probe asserts on the rendered DOM node, never an ancestor that merely
 * declares the property without inheritance reaching descendants.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

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

/** Set a note's body content via the API (no If-Match — force write). */
async function setNoteContent(
  jasper: JasperHandle,
  id: string,
  content: string,
): Promise<void> {
  const resp = await fetch(`${jasper.baseURL}/api/v1/notes/${id}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!resp.ok) throw new Error(`set content ${id}: ${resp.status}`);
}

test.describe("@phase23 design parity fixes", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("right-rail border: the RightRail <aside> computes a 1px solid left border", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });
    await waitForConnected(page, jasper.baseURL);

    // The resize-handle separator is a stable child of the rail <aside>
    // (only rendered while backlinksRailExpanded, true by default).
    // Its parent element IS the rendered rail node the border lives on.
    const railHandle = page.getByRole("separator", { name: "Resize backlinks panel" });
    await expect(railHandle).toBeVisible({ timeout: 10_000 });
    const rail = railHandle.locator("..");

    await expect
      .poll(() => rail.evaluate((el) => getComputedStyle(el).borderLeftWidth))
      .toBe("1px");
    await expect
      .poll(() => rail.evaluate((el) => getComputedStyle(el).borderLeftStyle))
      .toBe("solid");
  });

  // Removed: right-rail sub-headers (RightRailSubHeader, including the
  // uppercase/letter-spacing label this test guarded) were retired entirely
  // — all three panels are now header-less, identified
  // by the icon tab row alone. No sibling assertion survives; the
  // PARITY-02 border-left assertion above and PARITY-03 title-tracking
  // assertion below are unaffected and still cover this file's real scope.

  test("note title: the note-title element computes a non-normal (negative-tracking) letter-spacing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1512, height: 944 });

    const noteId = await createNote(jasper, "title-tracking-note");
    await setNoteContent(
      jasper,
      noteId,
      "# title-tracking-note\n\nBody text so the note has content.\n",
    );
    await waitForConnected(page, jasper.baseURL);
    await openNoteFromTree(page, noteId);

    const titleEl = page.getByTestId("editor-title-element");
    await expect(titleEl).toBeVisible({ timeout: 10_000 });

    await expect
      .poll(() => titleEl.evaluate((el) => getComputedStyle(el).letterSpacing))
      .not.toBe("normal");
  });
});
