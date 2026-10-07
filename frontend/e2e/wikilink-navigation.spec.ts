/**
 * Cmd/Ctrl-click on a rendered wiki-link opens its target; a plain click
 * only places the cursor. Each case proves the target opened by its body,
 * which the source note does not contain.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { noteRow, openNoteFromTree } from "./helpers/openNoteFromTree";

let jasper: JasperHandle;

test.beforeEach(async () => {
  jasper = await spawnJasper();
});

test.afterEach(async () => {
  if (jasper) await jasper.kill();
});

const TARGET_BODY = "body only the target holds";

async function connect(page: Page): Promise<void> {
  await page.goto(jasper.baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
}

async function apiCreateNote(page: Page, title: string, body: string): Promise<string> {
  const resp = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
    data: { parent_path: "", title },
  });
  expect(resp.status()).toBe(201);
  const { id } = (await resp.json()) as { id: string };
  const put = await page.request.put(`${jasper.baseURL}/api/v1/notes/${id}`, {
    data: { content: `# ${title}\n\n${body}\n` },
  });
  expect(put.status()).toBe(200);
  return id;
}

function editor(page: Page) {
  return page.locator(".cm-content").filter({ visible: true });
}

/** Opens the source with the cursor on its last line, so the link line renders. */
async function openSource(page: Page, sourceId: string): Promise<void> {
  await page.reload();
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute("data-status", "connected", {
    timeout: 10_000,
  });
  await openNoteFromTree(page, sourceId);
  await page.waitForSelector(".cm-content", { timeout: 5_000 });
  await page.locator(".cm-content").click();
  await page.keyboard.press("ControlOrMeta+End");
}

test.describe("@wikilink-nav", () => {
  for (const { link, shown } of [
    { link: "[[Nav Target]]", shown: "Nav Target" },
    { link: "[[Nav Target#Second]]", shown: "Nav Target > Second" },
    { link: "[[Nav Target|the target]]", shown: "the target" },
  ]) {
    test(`Cmd-click on ${link} opens the target`, async ({ page }) => {
      await connect(page);
      const targetId = await apiCreateNote(page, "Nav Target", `${TARGET_BODY}\n\n## Second\n\nmore`);
      const sourceId = await apiCreateNote(page, "Nav Source", `Go to ${link} now.\n\ntrailing line`);
      await openSource(page, sourceId);

      const widget = page.locator('.cm-wiki-link[data-wikilink-title="Nav Target"]');
      await expect(widget).toHaveText(shown, { timeout: 5_000 });

      await widget.click();
      await expect(noteRow(page, sourceId)).toHaveAttribute("data-active", "true");
      await expect(editor(page)).not.toContainText(TARGET_BODY);

      await page.keyboard.press("ControlOrMeta+End");
      await widget.click({ modifiers: ["ControlOrMeta"] });
      await expect(noteRow(page, targetId)).toHaveAttribute("data-active", "true", { timeout: 5_000 });
      await expect(editor(page)).toContainText(TARGET_BODY, { timeout: 5_000 });
    });
  }

  test("Cmd-click on a pending [[Title]] creates the note and opens it", async ({ page }) => {
    await connect(page);
    const sourceId = await apiCreateNote(page, "Pending Source", "Make [[Brand New Note]] here.\n\ntrailing line");
    await openSource(page, sourceId);

    const widget = page.locator('.cm-wiki-link-pending[data-wikilink-title="Brand New Note"]');
    await expect(widget).toBeVisible({ timeout: 5_000 });
    await widget.click({ modifiers: ["ControlOrMeta"] });

    const created = page.locator('[data-tree-row-kind="note"]').filter({ hasText: "Brand New Note" });
    await expect(created).toHaveAttribute("data-active", "true", { timeout: 5_000 });
    await expect(editor(page)).not.toContainText("Make ", { timeout: 5_000 });
  });
});
