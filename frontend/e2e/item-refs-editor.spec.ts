/**
 * References in the editor: the @ picker inserts the right form, a
 * reference renders as a chip with a hover card, and an upload is written
 * as an embed by id.
 */
import { test, expect, type Page } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { openNoteFromTree } from "./helpers/openNoteFromTree";

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

async function apiNoteContent(page: Page, id: string): Promise<string> {
  const resp = await page.request.get(`${jasper.baseURL}/api/v1/notes/${id}`);
  expect(resp.status()).toBe(200);
  return ((await resp.json()) as { content: string }).content;
}

async function openEditor(page: Page, id: string): Promise<void> {
  await openNoteFromTree(page, id);
  await page.waitForSelector(".cm-content", { timeout: 5_000 });
  await page.locator(".cm-content").click();
  await page.keyboard.press("End");
}

test.describe("@item-refs editor", () => {
  test("the @ picker inserts a title link, or an id link when the setting is on", async ({ page }) => {
    await connect(page);
    const target = await apiCreateNote(page, "Roadmap Alpha");
    const source = await apiCreateNote(page, "picker-source");
    await openEditor(page, source.id);

    await page.keyboard.type("\nSee @Roadm");
    const popup = page.locator(".cm-tooltip-autocomplete");
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator(".cm-completionLabel").first()).toHaveText("Roadmap Alpha");
    await popup.locator("li").first().click();
    await expect.poll(async () => await apiNoteContent(page, source.id), { timeout: 10_000 }).toContain("See [[Roadmap Alpha]]");

    const patch = await page.request.patch(`${jasper.baseURL}/api/v1/config`, {
      data: { editor: { idNoteLinks: true } },
    });
    expect(patch.status()).toBe(200);
    await page.reload();
    await openEditor(page, source.id);
    await page.keyboard.type("\nAnd @Roadm");
    await expect(popup).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator(".cm-completionLabel").first()).toHaveText("Roadmap Alpha");
    await popup.locator("li").first().click();
    await expect.poll(async () => await apiNoteContent(page, source.id), { timeout: 10_000 }).toContain(
      `And [[jasper:note/${target.id}|Roadmap Alpha]]`,
    );
  });

  test("a reference renders as a chip with the target's title and a hover card; a foreign one stays raw", async ({ page }) => {
    await connect(page);
    const target = await apiCreateNote(page, "Chip Target");
    const source = await apiCreateNote(page, "chip-source");
    await openEditor(page, source.id);

    await page.keyboard.type(`\n[[jasper:note/${target.id}]] and [[ado:workitem/12345|the ticket]]\n`);
    // The cursor moved to the next line, so the previous line renders.
    const chips = page.getByTestId("ref-chip");
    await expect(chips).toHaveCount(2, { timeout: 5_000 });
    await expect(chips.first()).toHaveAttribute("data-state", "ok", { timeout: 5_000 });
    await expect(chips.first().locator(".cm-ref-chip-label")).toHaveText("Chip Target");
    await expect(chips.nth(1)).toHaveAttribute("data-state", "foreign");
    await expect(chips.nth(1).locator(".cm-ref-chip-label")).toHaveText("the ticket");

    await chips.first().hover();
    const card = page.getByTestId("ref-hover-card");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Chip Target");
    await expect(card).toContainText("note · ok");

    // The reference and the backlink are recorded.
    await expect
      .poll(async () => {
        const resp = await page.request.get(
          `${jasper.baseURL}/api/v1/refs/backlinks?id=${encodeURIComponent("ado:workitem/12345")}`,
        );
        const body = (await resp.json()) as { backlinks: Array<{ source_id: string; display: string }> };
        return body.backlinks.map((b) => `${b.source_id}|${b.display}`);
      }, { timeout: 10_000 })
      .toEqual([`${source.id}|the ticket`]);
  });

  test("a deleted target shows as deleted with its last title", async ({ page }) => {
    await connect(page);
    const target = await apiCreateNote(page, "Doomed Note");
    const source = await apiCreateNote(page, "deleted-source");
    const del = await page.request.delete(`${jasper.baseURL}/api/v1/notes/${target.id}`);
    expect(del.status()).toBe(204);

    await openEditor(page, source.id);
    await page.keyboard.type(`\n[[jasper:note/${target.id}]]\n`);
    const chip = page.getByTestId("ref-chip").first();
    await expect(chip).toHaveAttribute("data-state", "deleted", { timeout: 5_000 });
    await expect(chip.locator(".cm-ref-chip-label")).toHaveText("Doomed Note");
  });
});
