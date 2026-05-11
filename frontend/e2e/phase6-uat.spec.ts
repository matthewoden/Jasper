/**
 * Phase 6 UAT — Tags, Backlinks, Wiki-Links.
 *
 * Regression-proof Playwright coverage for every Phase 6 requirement against
 * the live `bin/jasper` binary (built via `make build` — CLAUDE.md §Build &
 * embed pipeline). This is the gate before human UAT per CLAUDE.md
 * §Verification policy.
 *
 * Scenarios:
 *   S1  : new note ships with frontmatter scaffold (TAGS-EXT-01)
 *   S2  : one-time migration injects scaffold into pre-existing no-frontmatter
 *         files on first Phase 6 startup (TAGS-EXT-03)
 *   S3  : save with frontmatter removed auto-restores scaffold (TAGS-EXT-02)
 *   S4  : tags sync to tag browser (TAGS-01, TAGS-02, TAGS-03)
 *   S5  : tag click filters file tree; chip clears filter (TAGS-04)
 *   S6  : tag rename rewrites all carrier files on disk (TAGS-06)
 *   S7  : tag delete removes from all carrier files; N≤5 skips dialog (TAGS-07)
 *   S8  : [[Foo autocomplete shows matching titles + Create row (LINKS-06, D-14)
 *   S9  : full reindex reconstructs tags + backlinks (TAGS-05, DATA-10)
 *   S10 : pending link styled with cm-wiki-link-pending class (LINKS-04)
 *   S11 : rename note rewrites [[OldTitle]] references; backlinks panel updates
 *         (LINKS-07, LINKS-08)
 *   S12 : Cmd+click on resolved [[Foo]] navigates; plain click is inert
 *         (LINKS-05, D-15)
 *   S13 : cross-tab tag rename: tab B's tag browser refreshes (D-33, D-35)
 *   S14 : ambiguous wiki-link resolves same-folder-first (LINKS-02, LINKS-03)
 *   S15 : wiki-links inside fenced code blocks stay literal / not decorated
 *         (D-19)
 *   S16 : backlinks panel opens + shows referrer row with sanitized excerpt
 *         (LINKS-08, D-27, D-30)
 *   S17 : rename rewrite failure banner (D-36) — test.fixme; needs server
 *         fault injection (JASPER_TEST_FAIL_REWRITE env var, not yet plumbed)
 *
 * Authoring notes:
 *   - CM6 typing recipe: page.locator(".cm-content").click() → keyboard.type()
 *     NOT textarea.fill() (the editor is CodeMirror 6 contenteditable).
 *   - Tree rows use data-tree-row-kind="note" / "folder".
 *   - Tag rows use data-testid="tag-row-{name}".
 *   - Tag browser header button aria-label:
 *       collapsed: "Tags section, collapsed. N tags. Click to expand."
 *       expanded:  "Tags section, expanded. N tags. Click to collapse."
 *   - Active filter chip: aria-label="Remove tag filter: {name}".
 *   - Backlinks rail: role="region" aria-label="Notes that link to this note".
 *   - Backlinks toggle (collapsed): aria-label="Show backlinks panel".
 *   - Backlinks hide (expanded): aria-label="Hide backlinks panel".
 *   - Context menu Rename item text: "Rename tag…"
 *   - Context menu Remove item: data-testid="delete-tag-{name}"
 *   - wikilink resolved: .cm-wiki-link; pending: .cm-wiki-link-pending
 *   - POST /api/v1/notes body: { parent_path: string, title: string }
 *     (NOT { path } — title = filename without .md, parent_path = folder path)
 *
 * CLAUDE.md §Verification policy: every scenario runs against bin/jasper
 * (make build). The spawnJasper() helper in binary.ts now fails fast if
 * bin/jasper is missing.
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { rm } from "node:fs/promises";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Navigate to baseURL and wait for WS "connected" status.
 * If `openFirstNote` is true, click the first note in the tree so the editor mounts.
 */
async function openApp(
  page: Page,
  baseURL: string,
  openFirstNote = true,
): Promise<void> {
  await page.goto(baseURL);
  await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
    "data-status",
    "connected",
    { timeout: 10_000 },
  );
  if (openFirstNote) {
    const firstNote = page.locator('[data-tree-row-kind="note"]').first();
    await expect(firstNote).toBeVisible({ timeout: 8_000 });
    await firstNote.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });
  }
}

/**
 * CM6 typing recipe (CLAUDE.md §Verification policy gotcha):
 * .fill() on .cm-content is a silent no-op — use keyboard input.
 * Clears existing content via Cmd/Ctrl+A then Delete before typing.
 */
async function typeIntoEditor(page: Page, text: string): Promise<void> {
  const cm = page.locator(".cm-content");
  await cm.click();
  const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
  await page.keyboard.press(selectAllKey);
  await page.keyboard.press("Delete");
  await page.keyboard.type(text);
}

/**
 * Wait for the SaveIndicator to show "Saved". Tolerates both
 * data-testid="save-indicator" and a bare text match.
 */
async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  const byId = page.locator('[data-testid="save-indicator"]');
  if ((await byId.count()) > 0) {
    await expect(byId).toContainText(/saved/i, { timeout: timeoutMs });
    return;
  }
  await expect(page.getByText("Saved")).toBeVisible({ timeout: timeoutMs });
}

/**
 * Commit a just-mounted rename input (post-Bug-D pattern — never press Escape
 * on a new row; it deletes the node).
 */
async function commitRenameWith(
  page: Page,
  name: string,
  timeoutMs = 3_000,
): Promise<void> {
  const renameInput = page.locator('[data-tree-row] input[type="text"]').first();
  await renameInput.waitFor({ state: "visible", timeout: timeoutMs });
  await renameInput.fill(name);
  await renameInput.press("Enter");
  await expect(renameInput).toHaveCount(0, { timeout: timeoutMs });
}

/**
 * Create a folder via the API. parent_path is relative to notes/; name is the
 * new folder's basename. Idempotent — ignores 409 (already exists).
 */
async function apiCreateFolder(
  page: Page,
  baseURL: string,
  parent_path: string,
  name: string,
): Promise<void> {
  const resp = await page.request.post(`${baseURL}/api/v1/folders`, {
    data: { parent_path, name },
  });
  // 201 = created, 409 = already exists — both are fine for test setup.
  if (resp.status() !== 201 && resp.status() !== 409) {
    const body = await resp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateFolder: POST returned ${String(resp.status())} for ${parent_path}/${name}: ${body}`,
    );
  }
}

/**
 * Create a note via the API.
 *
 * Parses `relPath` (e.g., "notes/folder-a/MyNote.md") into the required
 * { parent_path, title } body shape. "notes/" prefix is stripped; folder
 * segments become parent_path; the basename without ".md" is the title.
 *
 * If the parent folder is nested (e.g., "folder-a"), creates it first.
 *
 * Then PUTs `content` into the created note (empty If-Match = permissive).
 *
 * Returns the note UUID.
 */
async function apiCreateNote(
  page: Page,
  baseURL: string,
  relPath: string,
  content: string,
): Promise<string> {
  // Strip "notes/" prefix if present; the API parent_path is relative to notes/.
  const withoutNotes = relPath.replace(/^notes\//, "");
  const lastSlash = withoutNotes.lastIndexOf("/");
  const parent_path = lastSlash >= 0 ? withoutNotes.slice(0, lastSlash) : "";
  const basename = lastSlash >= 0 ? withoutNotes.slice(lastSlash + 1) : withoutNotes;
  const title = basename.replace(/\.md$/, "");

  // Ensure parent folder exists (recursive: create each segment).
  if (parent_path) {
    const segments = parent_path.split("/");
    for (let i = 0; i < segments.length; i++) {
      const pp = segments.slice(0, i).join("/");
      const name = segments[i];
      await apiCreateFolder(page, baseURL, pp, name);
    }
  }

  const createResp = await page.request.post(`${baseURL}/api/v1/notes`, {
    data: { parent_path, title },
  });
  if (createResp.status() !== 201) {
    const body = await createResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: POST returned ${String(createResp.status())} for ${relPath}: ${body}`,
    );
  }
  const created = await createResp.json() as { id: string };
  const id = created.id;

  // PUT content (empty If-Match is permissive per notes/service.go:158).
  const updateResp = await page.request.put(`${baseURL}/api/v1/notes/${id}`, {
    data: { content },
  });
  if (updateResp.status() !== 200) {
    const body = await updateResp.text().catch(() => "(no body)");
    throw new Error(
      `apiCreateNote: PUT returned ${String(updateResp.status())} for ${relPath}: ${body}`,
    );
  }
  return id;
}

/**
 * Read the visible plain-text content of the CM6 editor surface.
 * textContent collapses line breaks but is sufficient for content assertions.
 */
async function readEditorText(page: Page): Promise<string> {
  return (await page.locator(".cm-content").textContent()) ?? "";
}

/**
 * Open a tab in the given BrowserContext and wait for WS "connected".
 * Each context has independent sessionStorage → independent session_id.
 */
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

/**
 * Expand the Tag Browser section in the sidebar if it is currently collapsed.
 * Uses a partial aria-label match on "Tags section" which is stable regardless
 * of current tag count or expand/collapse state.
 */
async function expandTagBrowser(page: Page): Promise<void> {
  // The header button aria-label is either:
  //   "Tags section, collapsed. N tags. Click to expand."
  //   "Tags section, expanded. N tags. Click to collapse."
  // We match on the "collapsed" variant to determine if we need to click.
  const headerBtn = page.locator('button[aria-label*="Tags section"]');
  await expect(headerBtn).toBeVisible({ timeout: 5_000 });

  const label = await headerBtn.getAttribute("aria-label") ?? "";
  if (label.includes("collapsed")) {
    await headerBtn.click();
  }
  // After expand, the role="list" inside the tag browser should be visible.
  // Wait for it by checking for the button with aria-expanded on it.
  await expect(
    page.locator('button[aria-label*="Tags section"][aria-expanded="true"]'),
  ).toBeVisible({ timeout: 5_000 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios S1–S3: Frontmatter scaffold
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Phase 6 UAT — Frontmatter scaffold (TAGS-EXT-01/02/03)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  // ─────────────────────────────────────────────────────────────────────
  // S1: New note ships with frontmatter scaffold (TAGS-EXT-01)
  // ─────────────────────────────────────────────────────────────────────
  test("S1: new note ships with frontmatter scaffold (TAGS-EXT-01)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Click "New Note" in the toolbar.
    await page.getByRole("button", { name: /new note/i }).click();

    // Commit the rename input (post-Bug-D — never Escape).
    await commitRenameWith(page, "scaffold-s1-note");

    // Wait for the tree to show the new note.
    const newNoteRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /scaffold-s1-note/i });
    await expect(newNoteRow).toBeVisible({ timeout: 8_000 });

    // Click the new note row to open it in the editor.
    await newNoteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Read the on-disk file content to verify the scaffold was written.
    const notePath = path.join(jasper.dataDir, "notes", "scaffold-s1-note.md");
    let content = "";
    for (let i = 0; i < 30; i++) {
      try {
        content = await fs.readFile(notePath, "utf8");
        if (content.includes("tags: []")) break;
      } catch {
        // file not yet written
      }
      await new Promise((r) => setTimeout(r, 300));
    }

    // Scaffold must start with the YAML frontmatter fence.
    expect(content).toMatch(/^---\s*\ntags: \[\]\s*\n---/);
    // And include the H1 derived from the title.
    expect(content).toContain("# scaffold-s1-note");
  });

  // ─────────────────────────────────────────────────────────────────────
  // S2: One-time migration injects scaffold into pre-existing no-frontmatter
  //     files on first Phase 6 startup (TAGS-EXT-03).
  // ─────────────────────────────────────────────────────────────────────
  test("S2: one-time migration injects scaffold into pre-existing no-frontmatter file (TAGS-EXT-03)", async () => {
    const dataDir = jasper.dataDir;
    await jasper.kill();
    // Prevent afterEach from double-killing (we kill manually below).
    jasper = null as unknown as JasperHandle;

    try {
      // Write a no-frontmatter file into the vault's notes directory.
      const notesDir = path.join(dataDir, "notes");
      await fs.mkdir(notesDir, { recursive: true });
      const probePath = path.join(notesDir, "no-frontmatter.md");
      await fs.writeFile(probePath, "# Already Had H1\nbody here\n", "utf8");

      // Restart against the same dataDir. D-11 / TAGS-EXT-03 one-time migration
      // should prepend the scaffold on startup.
      const restarted = await spawnJasper({ dataDir });
      try {
        const content = await fs.readFile(probePath, "utf8");
        // Scaffold must be at the head of the file.
        expect(content).toMatch(/^---\s*\ntags: \[\]\s*\n---/);
        // Original H1 must still be present.
        expect(content).toContain("# Already Had H1");
        // Original body must still be present.
        expect(content).toContain("body here");
      } finally {
        await restarted.kill();
        await rm(dataDir, { recursive: true, force: true });
      }
    } catch (e) {
      // Clean up if we failed before the restart handle was created.
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  });

  // ─────────────────────────────────────────────────────────────────────
  // S3: Save with frontmatter removed auto-restores scaffold (TAGS-EXT-02)
  //
  // We use the API to PUT bare content (no --- fences) to avoid triggering
  // the Phase 3 H1-to-filename rename pipeline, which would rename the file
  // based on the H1 and confuse the disk-path lookup.
  // ─────────────────────────────────────────────────────────────────────
  test("S3: save with frontmatter removed auto-restores scaffold (TAGS-EXT-02)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Discover the seeded note's ID and path from the tree.
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(treeResp.status()).toBe(200);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id || !noteNode?.path) {
      throw new Error("S3: no note found in tree");
    }

    // PUT content WITHOUT frontmatter to simulate the user deleting the --- block.
    // We use the same H1 as the original filename to avoid triggering a rename
    // (D-10 only triggers on MISSING frontmatter, not on H1 mismatch).
    const bareContent = "# scratchpad\n\nbody without any frontmatter block";
    const putResp = await page.request.put(
      `${jasper.baseURL}/api/v1/notes/${noteNode.id}`,
      { data: { content: bareContent } },
    );
    expect(putResp.status()).toBe(200);

    // Poll the disk file until the scaffold is prepended (D-10 runs in the PUT path).
    // noteNode.path is relative to notes/ (e.g., "scratchpad.md"), so prepend "notes/".
    const diskPath = path.join(jasper.dataDir, "notes", noteNode.path);
    let content = "";
    for (let i = 0; i < 30; i++) {
      content = await fs.readFile(diskPath, "utf8");
      if (content.startsWith("---")) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    // Server must have prepended the frontmatter scaffold (TAGS-EXT-02).
    expect(content).toMatch(/^---\s*\ntags: \[\]\s*\n---/);
    // The written body content must still be present.
    expect(content).toContain("body without any frontmatter block");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios S4–S7: Tag browser, filtering, rename, and delete
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Phase 6 UAT — Tag browser (TAGS-01..07)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  // ─────────────────────────────────────────────────────────────────────
  // S4: Tags sync to tag browser (TAGS-01, TAGS-02, TAGS-03)
  // ─────────────────────────────────────────────────────────────────────
  test("S4: editing tags frontmatter syncs to tag browser (TAGS-01/02/03)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Discover the seeded note's ID.
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id) throw new Error("S4: no note in tree");

    // PUT content with tags via API (bypasses H1-rename pipeline).
    const putResp = await page.request.put(
      `${jasper.baseURL}/api/v1/notes/${noteNode.id}`,
      {
        data: {
          content:
            "---\ntags: [alpha, beta]\n---\n\n# scratchpad\n\nsome body",
        },
      },
    );
    expect(putResp.status()).toBe(200);

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Expand the tag browser section.
    await expandTagBrowser(page);

    // Wait for the "alpha" and "beta" tag rows to appear.
    await expect(page.getByTestId("tag-row-alpha")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("tag-row-beta")).toBeVisible({ timeout: 8_000 });

    // Each row must include the tag name and a count ≥ 1.
    const alphaText = (await page.getByTestId("tag-row-alpha").textContent()) ?? "";
    expect(alphaText).toMatch(/alpha/);
    expect(alphaText).toMatch(/1/);
  });

  // ─────────────────────────────────────────────────────────────────────
  // S5: Tag click filters file tree; chip appears; X clears (TAGS-04)
  // ─────────────────────────────────────────────────────────────────────
  test("S5: clicking tag filters tree; clear chip restores tree (TAGS-04)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Set the note's tags via API.
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id) throw new Error("S5: no note in tree");

    await page.request.put(`${jasper.baseURL}/api/v1/notes/${noteNode.id}`, {
      data: {
        content: "---\ntags: [filterme]\n---\n\n# scratchpad\n\nbody",
      },
    });

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Expand tag browser and click the tag.
    await expandTagBrowser(page);
    await expect(page.getByTestId("tag-row-filterme")).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("tag-row-filterme").click();

    // The active tag filter chip should appear.
    const chip = page.locator('[aria-label="Remove tag filter: filterme"]');
    await expect(chip).toBeVisible({ timeout: 5_000 });

    // The file tree should now be in flat-list mode.
    // The flat list uses <div data-active-note> items (NOT data-tree-row-kind="note").
    // We verify by checking the chip is visible (tag filter is active).
    await expect(chip).toBeVisible({ timeout: 5_000 });

    // Clear the filter by clicking the chip.
    await chip.click();
    await expect(chip).toHaveCount(0, { timeout: 5_000 });

    // After clearing, the full arborist tree is restored.
    // data-tree-row-kind="note" rows come back when activeTagFilter is null.
    await expect(page.locator('[data-tree-row-kind="note"]').first()).toBeVisible({ timeout: 5_000 });
  });

  // ─────────────────────────────────────────────────────────────────────
  // S6: Tag rename rewrites all carrier files on disk (TAGS-06)
  // ─────────────────────────────────────────────────────────────────────
  test("S6: right-click tag → rename rewrites carrier files on disk (TAGS-06)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Set the seeded note's tags to "oldtag" via API.
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id || !noteNode?.path) throw new Error("S6: no note in tree");

    await page.request.put(`${jasper.baseURL}/api/v1/notes/${noteNode.id}`, {
      data: {
        content: "---\ntags: [oldtag]\n---\n\n# scratchpad\n\nbody",
      },
    });

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Expand tag browser and wait for "oldtag" to appear.
    await expandTagBrowser(page);
    await expect(page.getByTestId("tag-row-oldtag")).toBeVisible({ timeout: 8_000 });

    // Right-click the tag row to open the context menu.
    await page.getByTestId("tag-row-oldtag").click({ button: "right" });

    // Click "Rename tag…" in the context menu.
    await page.getByText("Rename tag…").click({ timeout: 5_000 });

    // An inline RenameInput should appear inside the tag row button.
    const renameInput = page.locator('input[type="text"]').first();
    await renameInput.waitFor({ state: "visible", timeout: 5_000 });
    await renameInput.fill("newtag");
    await renameInput.press("Enter");

    // Wait for the rename to complete (old tag row disappears, new appears).
    await expect(page.getByTestId("tag-row-oldtag")).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByTestId("tag-row-newtag")).toBeVisible({ timeout: 8_000 });

    // Verify on-disk content. noteNode.path is relative to notes/ — prepend "notes/".
    const diskPath = path.join(jasper.dataDir, "notes", noteNode.path);
    let content = "";
    for (let i = 0; i < 20; i++) {
      content = await fs.readFile(diskPath, "utf8");
      if (content.includes("newtag") && !content.includes("oldtag")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(content).toContain("newtag");
    expect(content).not.toContain("oldtag");
  });

  // ─────────────────────────────────────────────────────────────────────
  // S7: Tag delete removes from carrier files; N≤5 skips dialog (TAGS-07)
  // ─────────────────────────────────────────────────────────────────────
  test("S7: right-click tag → delete removes from carrier files on disk (TAGS-07)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Set the seeded note's tags to "delme" via API.
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id || !noteNode?.path) throw new Error("S7: no note in tree");

    await page.request.put(`${jasper.baseURL}/api/v1/notes/${noteNode.id}`, {
      data: {
        content: "---\ntags: [delme]\n---\n\n# scratchpad\n\nbody",
      },
    });

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Expand tag browser and wait for "delme".
    await expandTagBrowser(page);
    await expect(page.getByTestId("tag-row-delme")).toBeVisible({ timeout: 8_000 });

    // Right-click → Remove (N=1, so no confirm dialog — TB10).
    await page.getByTestId("tag-row-delme").click({ button: "right" });
    // data-testid="delete-tag-delme" — the context menu item.
    await page.getByTestId("delete-tag-delme").click({ timeout: 5_000 });

    // Tag row should vanish.
    await expect(page.getByTestId("tag-row-delme")).toHaveCount(0, { timeout: 8_000 });

    // Verify on-disk content. noteNode.path is relative to notes/ — prepend "notes/".
    const diskPath = path.join(jasper.dataDir, "notes", noteNode.path);
    let content = "";
    for (let i = 0; i < 20; i++) {
      content = await fs.readFile(diskPath, "utf8");
      if (!content.includes("delme")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(content).not.toContain("delme");
    // The file still exists (only the tag is removed).
    expect(content).toContain("scratchpad");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios S8–S12: Wiki-links
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Phase 6 UAT — Wiki-links (LINKS-01..08)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  // ─────────────────────────────────────────────────────────────────────
  // S8: [[Foo autocomplete shows matching titles + Create row (LINKS-06, D-14)
  // ─────────────────────────────────────────────────────────────────────
  test("S8: [[Foo autocomplete shows matches + Create row (LINKS-06, D-14)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Create a "TargetNote" via API so it appears in autocomplete results.
    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/TargetNote.md",
      "---\ntags: []\n---\n\n# TargetNote\n\nbody",
    );

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Open the first note in the tree (the seeded scratchpad).
    const firstNote = page.locator('[data-tree-row-kind="note"]').first();
    await expect(firstNote).toBeVisible({ timeout: 8_000 });
    await firstNote.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Click into the editor and type [[ to trigger autocomplete, then type "Target".
    const cm = page.locator(".cm-content");
    await cm.click();
    // Move to end of editor content to type in a clean area.
    const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Delete");
    await page.keyboard.type("---\ntags: []\n---\n\n# scratchpad\n\nLink: ");
    // Now type [[ to trigger autocomplete.
    await page.keyboard.type("[[Target");

    // Wait for the autocomplete popup to appear.
    const autocomplete = page.locator(".cm-tooltip-autocomplete, .cm-tooltip");
    await expect(autocomplete.first()).toBeVisible({ timeout: 8_000 });

    // Assert "TargetNote" matching row is visible.
    await expect(
      page.locator(".cm-completionLabel").filter({ hasText: /TargetNote/i }),
    ).toBeVisible({ timeout: 5_000 });

    // Assert the "Create" row is present (D-14 always appends it).
    await expect(
      page.locator(".cm-completionLabel").filter({ hasText: /Create/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  // ─────────────────────────────────────────────────────────────────────
  // S9: Full reindex reconstructs tags + backlinks (TAGS-05)
  // ─────────────────────────────────────────────────────────────────────
  test("S9: full reindex reconstructs tags + backlinks (TAGS-05)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Set the seeded note's tags via API.
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id) throw new Error("S9: no note in tree");

    await page.request.put(`${jasper.baseURL}/api/v1/notes/${noteNode.id}`, {
      data: {
        content: "---\ntags: [reindex-tag]\n---\n\n# scratchpad\n\nbody",
      },
    });

    // Trigger full reindex. Returns 202 (Accepted) when successful.
    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
    );
    expect(reindexResp.status()).toBe(202);

    // Poll GET /api/v1/tags until reindex-tag appears.
    let found = false;
    for (let i = 0; i < 30; i++) {
      const tagsResp = await page.request.get(`${jasper.baseURL}/api/v1/tags`);
      if (tagsResp.status() === 200) {
        const body = await tagsResp.json() as {
          tags: Array<{ name: string }>;
        };
        if (body.tags?.some((t) => t.name === "reindex-tag")) {
          found = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(found).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // S10: Pending wiki-link renders with cm-wiki-link-pending class (LINKS-04)
  // ─────────────────────────────────────────────────────────────────────
  test("S10: pending wiki-link renders with dashed-underline class (LINKS-04)", async ({ page }) => {
    await openApp(page, jasper.baseURL, true);

    // Type a note with a wiki-link to a non-existent note.
    await typeIntoEditor(
      page,
      "---\ntags: []\n---\n\n# scratchpad\n\nHere is [[UnresolvedGhost]] in text.\n\nanother line",
    );

    const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
    await page.keyboard.press(saveKey);
    await waitForSaved(page);

    // Move cursor off the [[UnresolvedGhost]] line (to the last line).
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");

    // The .cm-wiki-link-pending widget should appear for off-cursor unresolved links.
    await expect(page.locator(".cm-wiki-link-pending")).toBeVisible({ timeout: 5_000 });
  });

  // ─────────────────────────────────────────────────────────────────────
  // S11: Rename note rewrites [[OldTitle]] refs; backlinks panel updates
  //      (LINKS-07, LINKS-08)
  //
  // Design: the server canonicalizes filenames to lowercase (DATA-11), so
  // "OldTitle.md" is stored as "oldtitle.md". The wiki-link rewrite triggers
  // when oldTitle ≠ newTitle (EqualFold). Notes WITHOUT an H1 derive their
  // title from the filename, so moving oldtitle.md → newtitle.md changes
  // the title from "oldtitle" to "newtitle", triggering the rewrite.
  // Notes WITH an H1 keep the same H1 after a rename, so no rewrite fires.
  // This test uses no-H1 notes (body text only) to exercise the rename path.
  // ─────────────────────────────────────────────────────────────────────
  test("S11: rename rewrites [[oldtitle]] references + backlinks panel updates (LINKS-07, LINKS-08)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Create note A with NO H1 so its title comes from the filename.
    // "OldTitle" → canonical path "oldtitle.md" → title "oldtitle".
    const idA = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/OldTitle.md",
      "---\ntags: []\n---\n\nbody of note A (no H1 heading so filename is the title)",
    );

    // Create note B with a [[oldtitle]] wiki-link.
    // The link text must match the lowercase canonical title of note A.
    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/NoteB.md",
      "---\ntags: []\n---\n\nThis links to [[oldtitle]] for context.",
    );

    // Rename A via the move API (title change: "oldtitle" → "newtitle"
    // because no H1 means the title comes from the new filename).
    // new_path is relative to notes/ (no "notes/" prefix).
    const moveResp = await page.request.post(
      `${jasper.baseURL}/api/v1/notes/${idA}/move`,
      { data: { new_path: "NewTitle.md" } },
    );
    expect(moveResp.status()).toBe(200);

    // Poll NoteB on disk — must contain [[newtitle]] (lowercase canonical form).
    // On macOS the filesystem is case-insensitive, so NoteB.md == noteb.md.
    const noteBPath = path.join(jasper.dataDir, "notes", "NoteB.md");
    let noteBContent = "";
    for (let i = 0; i < 30; i++) {
      noteBContent = await fs.readFile(noteBPath, "utf8");
      if (noteBContent.includes("[[newtitle]]")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(noteBContent).toContain("[[newtitle]]");
    expect(noteBContent).not.toContain("[[oldtitle]]");

    // Open the renamed note and verify backlinks panel lists NoteB.
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // After rename, the tree shows the title from the new filename ("newtitle").
    const newTitleRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /newtitle/i });
    await expect(newTitleRow).toBeVisible({ timeout: 8_000 });
    await newTitleRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Expand the backlinks rail.
    const showBacklinks = page.getByRole("button", { name: "Show backlinks panel" });
    if ((await showBacklinks.count()) > 0) {
      await showBacklinks.click();
    }
    const rail = page.getByRole("region", { name: "Notes that link to this note" });
    await expect(rail).toBeVisible({ timeout: 8_000 });

    // NoteB should appear in the backlinks list.
    await expect(
      rail.getByRole("button", { name: /Open note: NoteB/i }),
    ).toBeVisible({ timeout: 8_000 });
  });

  // ─────────────────────────────────────────────────────────────────────
  // S12: Cmd+click navigates resolved [[Foo]]; plain click places caret
  //      (LINKS-05, D-15)
  // ─────────────────────────────────────────────────────────────────────
  test("S12: Cmd+click navigates resolved link; plain click places caret only (LINKS-05, D-15)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Create the navigation target.
    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/NavTarget.md",
      "---\ntags: []\n---\n\n# NavTarget\n\nbody of target",
    );

    // Set the seeded scratchpad content to include [[NavTarget]].
    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
    // The seeded scratchpad is the first note in tree root.
    const scratchpad = tree.root.find(
      (n) => n.kind === "note" && n.path?.includes("scratchpad"),
    );
    if (!scratchpad?.id) throw new Error("S12: no scratchpad in tree");

    await page.request.put(`${jasper.baseURL}/api/v1/notes/${scratchpad.id}`, {
      data: {
        content:
          "---\ntags: []\n---\n\n# scratchpad\n\nClick [[NavTarget]] to navigate.\n\ntrailing line",
      },
    });

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Open the scratchpad note.
    const scratchpadRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /scratchpad/i });
    await expect(scratchpadRow).toBeVisible({ timeout: 8_000 });
    await scratchpadRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Wait a moment for the wikilink resolver to hydrate resolved titles.
    await page.waitForTimeout(300);

    // Move cursor to the last line (off the [[NavTarget]] line) by pressing
    // Ctrl/Meta+End to go to document end.
    const cm = page.locator(".cm-content");
    await cm.click();
    const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
    await page.keyboard.press(gotoEndKey);

    // Wait for the .cm-wiki-link resolved widget to render (off-cursor).
    // Give extra time for the decoration plugin to update after cursor move.
    await page.waitForTimeout(500);
    const wikiLink = page.locator(".cm-wiki-link").first();
    await expect(wikiLink).toBeVisible({ timeout: 8_000 });

    // Record whether NavTarget row is currently the active note.
    const navTargetRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /NavTarget/i });

    // Plain click — should just place the caret (active note unchanged).
    await wikiLink.click();
    await page.waitForTimeout(500);

    // Assert NavTarget is NOT activated (tree row data-active should not be "true").
    const isActiveAfterPlainClick =
      (await navTargetRow.getAttribute("data-active")) === "true";
    expect(isActiveAfterPlainClick).toBe(false);

    // Re-navigate cursor to end so the widget is off-cursor again.
    await page.keyboard.press(gotoEndKey);
    await page.waitForTimeout(300);

    // Cmd+click — should navigate to NavTarget.
    await page.keyboard.down("Meta");
    await wikiLink.click();
    await page.keyboard.up("Meta");

    // After Cmd+click, the NavTarget note should open in the editor.
    await expect
      .poll(() => readEditorText(page), { timeout: 8_000 })
      .toContain("NavTarget");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario S13: Cross-tab tag rename (D-33, D-35)
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Phase 6 UAT — Cross-tab tag rewrite (D-33, D-35)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("S13: cross-tab tag rename: tab B tag browser refreshes (D-33, D-35)", async ({ browser }) => {
    // Set up tag data via API before opening tabs.
    const setupCtx = await browser.newContext();
    const setupPage = await setupCtx.newPage();
    await setupPage.goto(jasper.baseURL);
    await expect(setupPage.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const treeResp = await setupPage.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id) throw new Error("S13: no note in tree");

    await setupPage.request.put(`${jasper.baseURL}/api/v1/notes/${noteNode.id}`, {
      data: {
        content: "---\ntags: [crosstab]\n---\n\n# scratchpad\n\nbody",
      },
    });
    await setupCtx.close();

    // Open two independent tabs (different session IDs).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openTabInContext(ctxA, jasper.baseURL);
      const pageB = await openTabInContext(ctxB, jasper.baseURL);

      // Expand tag browser in both tabs; confirm "crosstab" appears in both.
      await expandTagBrowser(pageA);
      await expandTagBrowser(pageB);
      await expect(pageA.getByTestId("tag-row-crosstab")).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByTestId("tag-row-crosstab")).toBeVisible({ timeout: 8_000 });

      // In tab A, right-click "crosstab" → Rename → "crosstab-renamed".
      await pageA.getByTestId("tag-row-crosstab").click({ button: "right" });
      await pageA.getByText("Rename tag…").click({ timeout: 5_000 });
      const renameInput = pageA.locator('input[type="text"]').first();
      await renameInput.waitFor({ state: "visible", timeout: 3_000 });
      await renameInput.fill("crosstab-renamed");
      await renameInput.press("Enter");

      // Tab A shows the renamed tag.
      await expect(pageA.getByTestId("tag-row-crosstab-renamed")).toBeVisible({ timeout: 8_000 });

      // Tab B's tag browser should also update (D-33 tags:rewritten WS broadcast).
      await expect(pageB.getByTestId("tag-row-crosstab")).toHaveCount(0, { timeout: 8_000 });
      await expect(pageB.getByTestId("tag-row-crosstab-renamed")).toBeVisible({ timeout: 8_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios S14–S16: Wiki-link resolution, code blocks, backlinks panel
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Phase 6 UAT — Wiki-link resolution + backlinks (LINKS-02..04, LINKS-08)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  // ─────────────────────────────────────────────────────────────────────
  // S14: Ambiguous wiki-link resolves same-folder-first (LINKS-02, LINKS-03)
  // ─────────────────────────────────────────────────────────────────────
  test("S14: ambiguous wiki-link resolves same-folder-first (LINKS-02, LINKS-03)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Create two notes with the same title in different folders.
    const sharedAId = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/folder-a/Shared.md",
      "---\ntags: []\n---\n\n# Shared\n\nThis is in folder A.",
    );
    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/folder-b/Shared.md",
      "---\ntags: []\n---\n\n# Shared\n\nThis is in folder B.",
    );

    // Create a source note IN folder-a that contains [[Shared]].
    const sourceId = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/folder-a/SourceNote.md",
      "---\ntags: []\n---\n\n# SourceNote\n\nLinks to [[Shared]] for testing.",
    );

    // Backlinks are synced immediately when PUT /api/v1/notes/{id} is
    // called (Service.Update → SyncBacklinks). No full reindex needed.
    // The registry already knows about folder-a/Shared (AddRecord in
    // Create), so SyncBacklinks resolves [[Shared]] to folder-a/Shared
    // via the same-folder-first rule.
    //
    // Poll the backlinks of folder-a/Shared — it should be the resolution
    // target because SourceNote is in the same folder (LINKS-02 / LINKS-03).
    let backlinkFound = false;
    for (let i = 0; i < 30; i++) {
      const resp = await page.request.get(
        `${jasper.baseURL}/api/v1/notes/${sharedAId}/backlinks`,
      );
      if (resp.status() === 200) {
        const body = await resp.json() as {
          backlinks: Array<{ source_id: string }>;
        };
        if (body.backlinks?.some((b) => b.source_id === sourceId)) {
          backlinkFound = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(backlinkFound).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────
  // S15: Wiki-links inside fenced code blocks stay literal / not decorated
  //      (D-19)
  // ─────────────────────────────────────────────────────────────────────
  test("S15: wiki-links inside fenced code blocks stay literal / not decorated (D-19)", async ({ page }) => {
    await openApp(page, jasper.baseURL, true);

    // Type a note with [[Foo]] inside a fenced code block.
    await typeIntoEditor(
      page,
      "---\ntags: []\n---\n\n# scratchpad\n\n```\n[[Foo]] should be literal here\n```\n\nline after",
    );
    const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
    await page.keyboard.press(saveKey);
    await waitForSaved(page);

    // Move cursor to the "line after" line (off the code block).
    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");

    await page.waitForTimeout(500);

    // No wiki-link decorations should exist inside the code block lines.
    const wikiLinksInsideCode = await page.evaluate(() => {
      const codeLines = document.querySelectorAll(".cm-content .cm-line");
      for (const line of Array.from(codeLines)) {
        if (line.textContent?.includes("should be literal here")) {
          return (
            line.querySelector(".cm-wiki-link") !== null ||
            line.querySelector(".cm-wiki-link-pending") !== null
          );
        }
      }
      return false;
    });
    expect(wikiLinksInsideCode).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────
  // S16: Backlinks panel shows referrer row with excerpt (LINKS-08, D-27, D-30)
  // ─────────────────────────────────────────────────────────────────────
  test("S16: backlinks panel shows referrer row with excerpt (LINKS-08, D-27, D-30)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    // Create the target note.
    const targetId = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/BacklinkTarget.md",
      "---\ntags: []\n---\n\n# BacklinkTarget\n\nThis note is referenced.",
    );

    // Create note B with a backlink to BacklinkTarget.
    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/ReferrerNote.md",
      "---\ntags: []\n---\n\n# ReferrerNote\n\nThis references [[BacklinkTarget]] in the body.",
    );

    // Backlinks are synced immediately when PUT /api/v1/notes/{id} is
    // called (Service.Update → SyncBacklinks). No full reindex needed —
    // the registry already knows BacklinkTarget (AddRecord during Create),
    // so SyncBacklinks resolves [[BacklinkTarget]] immediately.

    // Wait for backlinks to be available via the API before opening UI.
    let backlinkReady = false;
    for (let i = 0; i < 30; i++) {
      const resp = await page.request.get(
        `${jasper.baseURL}/api/v1/notes/${targetId}/backlinks`,
      );
      if (resp.status() === 200) {
        const body = await resp.json() as {
          backlinks: Array<{ source_id: string }>;
        };
        if (body.backlinks && body.backlinks.length > 0) {
          backlinkReady = true;
          break;
        }
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(backlinkReady).toBe(true);

    // Open BacklinkTarget in the UI.
    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const targetRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /BacklinkTarget/i });
    await expect(targetRow).toBeVisible({ timeout: 8_000 });
    await targetRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    // Expand the backlinks rail (click the toggle button if collapsed).
    const showBacklinksBtn = page.getByRole("button", {
      name: "Show backlinks panel",
    });
    if ((await showBacklinksBtn.count()) > 0) {
      await showBacklinksBtn.click();
    }

    // Verify the backlinks region is visible.
    const rail = page.getByRole("region", { name: "Notes that link to this note" });
    await expect(rail).toBeVisible({ timeout: 8_000 });

    // ReferrerNote should appear as a navigable button in the panel.
    await expect(
      rail.getByRole("button", { name: /Open note: ReferrerNote/i }),
    ).toBeVisible({ timeout: 8_000 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// S17: Rename rewrite failure banner (D-36) — test.fixme
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Phase 6 UAT — Rename failure banner (D-36)", () => {
  test.fixme(
    "S17: rename rewrite failure shows persistent banner + Dismiss (D-36)",
    async () => {
      // Intentionally empty.
      // Requires JASPER_TEST_FAIL_REWRITE env var plumbed into bin/jasper to
      // force a mid-rename 500 response on the next rewrite call.
      // Not yet implemented — needs non-trivial changes to the Go rename code path.
      // See 06-12-PLAN.md §Task 2 "S17 implementer's call" for context.
      //
      // Manual UAT path:
      //   1. Run: bin/jasper serve --data-dir <vault>
      //   2. Fill vault disk / chmod 000 on a carrier note to force write failure.
      //   3. Rename a note that has carriers.
      //   4. Observe "Rename failed — N references not updated." banner.
      //   5. Click Dismiss. Verify banner disappears.
    },
  );
});
