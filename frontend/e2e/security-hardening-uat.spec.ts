/**
 * Deliberately makes NO rejection assertions. A browser owns the Host and Origin
 * headers and treats both as forbidden to page script, so a rejection test driven
 * from page context cannot forge a rebound Host or a cross-origin Origin — the
 * browser overwrites them with legitimate loopback values, the request passes, and
 * the test looks like it proved something while proving nothing. Every rejection
 * assertion lives in Go httptest, where the headers are settable.
 *
 * This suite covers the other half: the app still works with the Host allowlist,
 * the raw-file CSP, and the daily-note verb split in place.
 */
import { expect, test } from "@playwright/test";

import { spawnJasper, type JasperHandle } from "./helpers/binary";
import { localDateString } from "./helpers/localDate";
import { waitForConnected } from "./helpers/phase7Helpers";

test.describe("Security hardening — the app still works @security", () => {
  let jasper: JasperHandle;

  test.beforeAll(async () => {
    jasper = await spawnJasper();
  });

  test.afterAll(async () => {
    if (jasper) await jasper.kill();
  });

  test("SPA loads and the WebSocket connects under the Host allowlist", async ({ page }) => {
    await page.goto(jasper.baseURL);

    // waitForConnected asserts the live WS session, which is the half of the
    // rebinding fix that the router middleware alone would not cover: the Hub
    // checks Host itself before websocket.Accept.
    await waitForConnected(page);
    // The seeded scratchpad row proves the tree fetched and painted, i.e. the
    // API round-trips the SPA needs all cleared the Host allowlist.
    await expect(page.locator('[data-tree-row-kind="note"]').first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("a legit-origin mutation still passes the Origin and Host guards", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    // page.request inherits the page's origin, so this is the ordinary
    // same-origin case both guards must let through.
    const created = await page.request.post(`${jasper.baseURL}/api/v1/notes`, {
      data: { parent_path: "", title: "security-happy-path" },
    });
    expect(created.status()).toBe(201);
  });

  test("daily note: GET-then-POST-on-404 still opens today's note", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await waitForConnected(page);

    const today = localDateString();

    // GET is read-only now, so before creation it must 404 and write nothing.
    const beforeCreate = await page.request.get(
      `${jasper.baseURL}/api/v1/daily-notes/${today}`,
    );
    expect(beforeCreate.status()).toBe(404);

    // The UI drives the same GET-then-POST fallback the client library does.
    await page.getByRole("button", { name: /today/i }).first().click();
    await expect(page.locator(".cm-content:visible").first()).toBeVisible();

    const afterCreate = await page.request.get(
      `${jasper.baseURL}/api/v1/daily-notes/${today}`,
    );
    expect(afterCreate.status()).toBe(200);
  });

  test("an SVG in the vault renders inline and is served inert", async ({ page }) => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20">' +
      '<rect width="20" height="20" fill="green"/></svg>';

    const upload = await page.request.post(`${jasper.baseURL}/api/v1/files?path=`, {
      multipart: {
        file: { name: "diagram.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) },
      },
    });
    expect(upload.status()).toBe(201);

    const served = await page.request.get(
      `${jasper.baseURL}/api/v1/files?path=diagram.svg`,
    );
    expect(served.status()).toBe(200);

    // Still labelled as an image, so a note's <img> renders it...
    expect(served.headers()["content-type"]).toBe("image/svg+xml");
    expect(served.headers()["content-disposition"]).not.toContain("attachment");
    // ...but inert if navigated to as a top-level document.
    expect(served.headers()["content-security-policy"]).toContain("sandbox");
    expect(served.headers()["x-content-type-options"]).toBe("nosniff");
    expect(await served.text()).toBe(svg);
  });
});
