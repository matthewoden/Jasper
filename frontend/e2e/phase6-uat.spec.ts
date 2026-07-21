/**
 * Phase 6 UAT — Tags, Backlinks, Wiki-Links.
 *
 * Scenarios:
 *   S1  : new note ships with frontmatter scaffold
 *   S2  : one-time migration injects scaffold into pre-existing no-frontmatter files
 *   S3  : save with frontmatter removed auto-restores scaffold
 *   S4  : tags sync to tag browser
 *   S5  : tag click filters file tree; chip clears filter
 *   S6  : tag rename rewrites all carrier files on disk
 *   S7  : tag delete removes from all carrier files; N≤5 skips dialog
 *   S8  : [[Foo autocomplete shows matching titles + Create row
 *   S9  : full reindex reconstructs tags + backlinks
 *   S10 : pending link styled with cm-wiki-link-pending class
 *   S11 : rename note rewrites [[OldTitle]] references; backlinks panel updates
 *   S12 : Cmd+click on resolved [[Foo]] navigates; plain click is inert
 *   S13 : cross-tab tag rename: tab B's tag browser refreshes
 *   S14 : ambiguous wiki-link resolves same-folder-first
 *   S15 : wiki-links inside fenced code blocks stay literal / not decorated
 *   S16 : backlinks panel opens + shows referrer row with sanitized excerpt
 *   S17 : rename rewrite failure banner — test.fixme; needs server fault injection
 *
 * Selector notes:
 *   - CM6 editor is contenteditable — use keyboard.type(), not .fill().
 *   - Tree rows: data-tree-row-kind="note" / "folder"
 *   - Tag rows: data-testid="tag-row-{name}"
 *   - Active filter chip: aria-label="Remove tag filter: {name}"
 *   - Backlinks rail: role="region" aria-label="Notes that link to this note"
 *   - wikilink resolved: .cm-wiki-link; pending: .cm-wiki-link-pending
 *   - POST /api/v1/notes body: { parent_path: string, title: string }
 */
import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { spawnJasper, type JasperHandle } from "./helpers/binary";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { rm } from "node:fs/promises";


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
 * CM6 typing recipe: .fill() on .cm-content is a no-op (contenteditable).
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
 * Wait for the status-bar SaveIndicator to reach the saved state. It renders as
 * an icon-only button carrying data-save-state, so match that rather than text.
 */
async function waitForSaved(page: Page, timeoutMs = 10_000): Promise<void> {
  await expect(page.locator('[data-save-state="saved"]')).toBeVisible({ timeout: timeoutMs });
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
  const withoutNotes = relPath.replace(/^notes\//, "");
  const lastSlash = withoutNotes.lastIndexOf("/");
  const parent_path = lastSlash >= 0 ? withoutNotes.slice(0, lastSlash) : "";
  const basename = lastSlash >= 0 ? withoutNotes.slice(lastSlash + 1) : withoutNotes;
  const title = basename.replace(/\.md$/, "");

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
 * Reveal the right-rail Tags panel (Phase 30 TAGS-01 tab-row rework,
 * 30-05/30-08).
 *
 * The Phase 20 three-section stacked/collapsible rail (independent
 * SectionHeader "Expand/Collapse <Title> panel" toggles per section) was
 * replaced by a single-panel-at-a-time tab row: RightRailTabRow renders
 * icon-only Outline / Linked mentions / Tags tabs (aria-label = the panel
 * name), and exactly one panel is mounted below at a time, driven by the
 * persisted rightPanel field. The rail itself still defaults to expanded
 * (backlinksRailExpanded); if a prior test collapsed it, "Show panels" (the
 * TabStrip right-cluster reopen control) reveals it first.
 */
async function expandTagBrowser(page: Page): Promise<void> {
  const showPanels = page.getByRole("button", { name: "Show panels" });
  if (await showPanels.isVisible().catch(() => false)) {
    await showPanels.click();
  }
  await page.getByRole("button", { name: "Tags", exact: true }).click();
  await expect(page.getByText("Note tags", { exact: true })).toBeVisible({ timeout: 5_000 });
}

/**
 * Reveal the right-rail Linked mentions panel (Phase 20 rename, RSIDE-02;
 * Phase 30 tab-row rework). Same reopen model as expandTagBrowser; the
 * backlinks region (role="region" aria-label="Notes that link to this note")
 * lives inside once the Linked mentions tab is selected.
 */
async function openBacklinks(page: Page): Promise<void> {
  const showPanels = page.getByRole("button", { name: "Show panels" });
  if (await showPanels.isVisible().catch(() => false)) {
    await showPanels.click();
  }
  await page.getByRole("button", { name: "Linked mentions", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "Notes that link to this note" }),
  ).toBeVisible({ timeout: 5_000 });
}


test.describe("Phase 6 UAT — Frontmatter scaffold (TAGS-EXT-01/02/03)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("S1: new note ships with frontmatter scaffold (TAGS-EXT-01)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    await page.getByRole("button", { name: /new note/i }).click();

    await commitRenameWith(page, "scaffold-s1-note");

    const newNoteRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /scaffold-s1-note/i });
    await expect(newNoteRow).toBeVisible({ timeout: 8_000 });

    await newNoteRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

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

    expect(content).toMatch(/^---\s*\ntags: \[\]\s*\n---/);
    expect(content).toContain("# scaffold-s1-note");
  });

  test("S2: one-time migration injects scaffold into pre-existing no-frontmatter file (TAGS-EXT-03)", async () => {
    const dataDir = jasper.dataDir;
    await jasper.kill();
    jasper = null as unknown as JasperHandle;

    try {
      const notesDir = path.join(dataDir, "notes");
      await fs.mkdir(notesDir, { recursive: true });
      const probePath = path.join(notesDir, "no-frontmatter.md");
      await fs.writeFile(probePath, "# Already Had H1\nbody here\n", "utf8");

      const restarted = await spawnJasper({ dataDir });
      try {
        const content = await fs.readFile(probePath, "utf8");
        expect(content).toMatch(/^---\s*\ntags: \[\]\s*\n---/);
        expect(content).toContain("# Already Had H1");
        expect(content).toContain("body here");
      } finally {
        await restarted.kill();
        await rm(dataDir, { recursive: true, force: true });
      }
    } catch (e) {
      await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  });

  test("S3: save with frontmatter removed auto-restores scaffold (TAGS-EXT-02)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    expect(treeResp.status()).toBe(200);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id || !noteNode?.path) {
      throw new Error("S3: no note found in tree");
    }

    const bareContent = "# scratchpad\n\nbody without any frontmatter block";
    const putResp = await page.request.put(
      `${jasper.baseURL}/api/v1/notes/${noteNode.id}`,
      { data: { content: bareContent } },
    );
    expect(putResp.status()).toBe(200);

    const diskPath = path.join(jasper.dataDir, "notes", noteNode.path);
    let content = "";
    for (let i = 0; i < 30; i++) {
      content = await fs.readFile(diskPath, "utf8");
      if (content.startsWith("---")) break;
      await new Promise((r) => setTimeout(r, 300));
    }

    expect(content).toMatch(/^---\s*\ntags: \[\]\s*\n---/);
    expect(content).toContain("body without any frontmatter block");
  });
});


test.describe("Phase 6 UAT — Tag browser (TAGS-01..07)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("S4: editing tags frontmatter syncs to tag browser (TAGS-01/02/03)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string }>;
    };
    const noteNode = tree.root.find((n) => n.kind === "note");
    if (!noteNode?.id) throw new Error("S4: no note in tree");

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

    await expandTagBrowser(page);

    await expect(page.getByTestId("tag-row-alpha")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId("tag-row-beta")).toBeVisible({ timeout: 8_000 });

    const alphaText = (await page.getByTestId("tag-row-alpha").textContent()) ?? "";
    expect(alphaText).toMatch(/alpha/);
    expect(alphaText).toMatch(/1/);
  });

  test("S5: clicking tag filters tree; clear chip restores tree (TAGS-04)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

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

    await expandTagBrowser(page);
    await expect(page.getByTestId("tag-row-filterme")).toBeVisible({ timeout: 8_000 });
    await page.getByTestId("tag-row-filterme").click();

    const chip = page.locator('[aria-label="Remove tag filter: #filterme"]');
    await expect(chip).toBeVisible({ timeout: 5_000 });

    await chip.click();
    await expect(chip).toHaveCount(0, { timeout: 5_000 });

    await expect(page.locator('[data-tree-row-kind="note"]').first()).toBeVisible({ timeout: 5_000 });
  });

  test("S6: right-click tag → rename rewrites carrier files on disk (TAGS-06)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

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

    await expandTagBrowser(page);
    await expect(page.getByTestId("tag-row-oldtag")).toBeVisible({ timeout: 8_000 });

    await page.getByTestId("tag-row-oldtag").click({ button: "right" });

    await page.getByText("Rename tag…").click({ timeout: 5_000 });

    const renameInput = page.locator('input[type="text"]').first();
    await renameInput.waitFor({ state: "visible", timeout: 5_000 });
    await renameInput.fill("newtag");
    await renameInput.press("Enter");

    await expect(page.getByTestId("tag-row-oldtag")).toHaveCount(0, { timeout: 8_000 });
    await expect(page.getByTestId("tag-row-newtag")).toBeVisible({ timeout: 8_000 });

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

  test("S7: right-click tag → delete removes from carrier files on disk (TAGS-07)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

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

    await expandTagBrowser(page);
    await expect(page.getByTestId("tag-row-delme")).toBeVisible({ timeout: 8_000 });

    await page.getByTestId("tag-row-delme").click({ button: "right" });
    await page.getByTestId("delete-tag-delme").click({ timeout: 5_000 });

    await expect(page.getByTestId("tag-row-delme")).toHaveCount(0, { timeout: 8_000 });

    const diskPath = path.join(jasper.dataDir, "notes", noteNode.path);
    let content = "";
    for (let i = 0; i < 20; i++) {
      content = await fs.readFile(diskPath, "utf8");
      if (!content.includes("delme")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(content).not.toContain("delme");
    expect(content).toContain("scratchpad");
  });
});


test.describe("Phase 6 UAT — Wiki-links (LINKS-01..08)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("S8: [[Foo autocomplete shows matches + Create row (LINKS-06, D-14)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

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

    const firstNote = page.locator('[data-tree-row-kind="note"]').first();
    await expect(firstNote).toBeVisible({ timeout: 8_000 });
    await firstNote.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    const cm = page.locator(".cm-content");
    await cm.click();
    const selectAllKey = process.platform === "darwin" ? "Meta+a" : "Control+a";
    await page.keyboard.press(selectAllKey);
    await page.keyboard.press("Delete");
    await page.keyboard.type("---\ntags: []\n---\n\n# scratchpad\n\nLink: ");
    await page.keyboard.type("[[Target");

    const autocomplete = page.locator(".cm-tooltip-autocomplete, .cm-tooltip");
    await expect(autocomplete.first()).toBeVisible({ timeout: 8_000 });

    await expect(
      page.locator(".cm-completionLabel").filter({ hasText: /TargetNote/i }),
    ).toBeVisible({ timeout: 5_000 });

    await expect(
      page.locator(".cm-completionLabel").filter({ hasText: /Create/i }),
    ).toBeVisible({ timeout: 5_000 });
  });

  test("S9: full reindex reconstructs tags + backlinks (TAGS-05)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

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

    const reindexResp = await page.request.post(
      `${jasper.baseURL}/api/v1/admin/reindex`,
    );
    expect(reindexResp.status()).toBe(202);

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

  test("S10: pending wiki-link renders with dashed-underline class (LINKS-04)", async ({ page }) => {
    await openApp(page, jasper.baseURL, true);

    await typeIntoEditor(
      page,
      "---\ntags: []\n---\n\n# scratchpad\n\nHere is [[UnresolvedGhost]] in text.\n\nanother line",
    );

    const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
    await page.keyboard.press(saveKey);
    await waitForSaved(page);

    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");

    await expect(page.locator(".cm-wiki-link-pending")).toBeVisible({ timeout: 5_000 });
  });

  test("S11: rename rewrites [[oldtitle]] references + backlinks panel updates (LINKS-07, LINKS-08)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const idA = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/OldTitle.md",
      "---\ntags: []\n---\n\nbody of note A (no H1 heading so filename is the title)",
    );

    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/NoteB.md",
      "---\ntags: []\n---\n\nThis links to [[oldtitle]] for context.",
    );

    const moveResp = await page.request.post(
      `${jasper.baseURL}/api/v1/notes/${idA}/move`,
      { data: { new_path: "NewTitle.md" } },
    );
    expect(moveResp.status()).toBe(200);

    const noteBPath = path.join(jasper.dataDir, "notes", "NoteB.md");
    let noteBContent = "";
    for (let i = 0; i < 30; i++) {
      noteBContent = await fs.readFile(noteBPath, "utf8");
      if (noteBContent.includes("[[newtitle]]")) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    expect(noteBContent).toContain("[[newtitle]]");
    expect(noteBContent).not.toContain("[[oldtitle]]");

    await page.reload();
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const newTitleRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /newtitle/i });
    await expect(newTitleRow).toBeVisible({ timeout: 8_000 });
    await newTitleRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    await openBacklinks(page);
    const rail = page.getByRole("region", { name: "Notes that link to this note" });
    await expect(rail).toBeVisible({ timeout: 8_000 });

    await expect(
      rail.getByRole("button", { name: /Open note: NoteB/i }),
    ).toBeVisible({ timeout: 8_000 });
  });

  test("S12: Cmd+click navigates resolved link; plain click places caret only (LINKS-05, D-15)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/NavTarget.md",
      "---\ntags: []\n---\n\n# NavTarget\n\nbody of target",
    );

    const treeResp = await page.request.get(`${jasper.baseURL}/api/v1/tree`);
    const tree = await treeResp.json() as {
      root: Array<{ kind: string; id?: string; path?: string }>;
    };
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

    const scratchpadRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /scratchpad/i });
    await expect(scratchpadRow).toBeVisible({ timeout: 8_000 });
    await scratchpadRow.click();
    await page.waitForSelector(".cm-content", { timeout: 8_000 });

    await page.waitForTimeout(300);

    const cm = page.locator(".cm-content");
    await cm.click();
    const gotoEndKey = process.platform === "darwin" ? "Meta+End" : "Control+End";
    await page.keyboard.press(gotoEndKey);

    await page.waitForTimeout(500);
    const wikiLink = page.locator(".cm-wiki-link").first();
    await expect(wikiLink).toBeVisible({ timeout: 8_000 });

    const navTargetRow = page
      .locator('[data-tree-row-kind="note"]')
      .filter({ hasText: /NavTarget/i });

    await wikiLink.click();
    await page.waitForTimeout(500);

    const isActiveAfterPlainClick =
      (await navTargetRow.getAttribute("data-active")) === "true";
    expect(isActiveAfterPlainClick).toBe(false);

    await page.keyboard.press(gotoEndKey);
    await page.waitForTimeout(300);

    await page.keyboard.down("Meta");
    await wikiLink.click();
    await page.keyboard.up("Meta");

    await expect
      .poll(() => readEditorText(page), { timeout: 8_000 })
      .toContain("NavTarget");
  });
});


test.describe("Phase 6 UAT — Cross-tab tag rewrite (D-33, D-35)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("S13: cross-tab tag rename: tab B tag browser refreshes (D-33, D-35)", async ({ browser }) => {
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

    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    try {
      const pageA = await openTabInContext(ctxA, jasper.baseURL);
      const pageB = await openTabInContext(ctxB, jasper.baseURL);

      await expandTagBrowser(pageA);
      await expandTagBrowser(pageB);
      await expect(pageA.getByTestId("tag-row-crosstab")).toBeVisible({ timeout: 8_000 });
      await expect(pageB.getByTestId("tag-row-crosstab")).toBeVisible({ timeout: 8_000 });

      await pageA.getByTestId("tag-row-crosstab").click({ button: "right" });
      await pageA.getByText("Rename tag…").click({ timeout: 5_000 });
      const renameInput = pageA.locator('input[type="text"]').first();
      await renameInput.waitFor({ state: "visible", timeout: 3_000 });
      await renameInput.fill("crosstab-renamed");
      await renameInput.press("Enter");

      await expect(pageA.getByTestId("tag-row-crosstab-renamed")).toBeVisible({ timeout: 8_000 });

      await expect(pageB.getByTestId("tag-row-crosstab")).toHaveCount(0, { timeout: 8_000 });
      await expect(pageB.getByTestId("tag-row-crosstab-renamed")).toBeVisible({ timeout: 8_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});


test.describe("Phase 6 UAT — Wiki-link resolution + backlinks (LINKS-02..04, LINKS-08)", () => {
  let jasper: JasperHandle;

  test.beforeEach(async () => {
    jasper = await spawnJasper();
  });

  test.afterEach(async () => {
    if (jasper) await jasper.kill();
  });

  test("S14: ambiguous wiki-link resolves same-folder-first (LINKS-02, LINKS-03)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

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

    const sourceId = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/folder-a/SourceNote.md",
      "---\ntags: []\n---\n\n# SourceNote\n\nLinks to [[Shared]] for testing.",
    );

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

  test("S15: wiki-links inside fenced code blocks stay literal / not decorated (D-19)", async ({ page }) => {
    await openApp(page, jasper.baseURL, true);

    await typeIntoEditor(
      page,
      "---\ntags: []\n---\n\n# scratchpad\n\n```\n[[Foo]] should be literal here\n```\n\nline after",
    );
    const saveKey = process.platform === "darwin" ? "Meta+s" : "Control+s";
    await page.keyboard.press(saveKey);
    await waitForSaved(page);

    const cm = page.locator(".cm-content");
    await cm.click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");

    await page.waitForTimeout(500);

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

  test("S16: backlinks panel shows referrer row with excerpt (LINKS-08, D-27, D-30)", async ({ page }) => {
    await page.goto(jasper.baseURL);
    await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
      "data-status",
      "connected",
      { timeout: 10_000 },
    );

    const targetId = await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/BacklinkTarget.md",
      "---\ntags: []\n---\n\n# BacklinkTarget\n\nThis note is referenced.",
    );

    await apiCreateNote(
      page,
      jasper.baseURL,
      "notes/ReferrerNote.md",
      "---\ntags: []\n---\n\n# ReferrerNote\n\nThis references [[BacklinkTarget]] in the body.",
    );


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

    await openBacklinks(page);
    const rail = page.getByRole("region", { name: "Notes that link to this note" });
    await expect(rail).toBeVisible({ timeout: 8_000 });

    await expect(
      rail.getByRole("button", { name: /Open note: ReferrerNote/i }),
    ).toBeVisible({ timeout: 8_000 });
  });
});


test.describe("Phase 6 UAT — Rename failure banner (D-36)", () => {
  test("S17: rename rewrite failure shows persistent banner + Dismiss (D-36)", async ({ page }) => {
    const jasper = await spawnJasper({ env: { JASPER_TEST_FAIL_REWRITE: "1" } });
    try {
      // Register the vault so the app bypasses the first-run picker.
      // --vault <dataDir> initializes the vault on disk but does not register
      // it in the vault registry; the UI shows the picker until vault/open is
      // called to register the path.
      const openResp = await page.request.post(
        `${jasper.baseURL}/api/v1/vault/open`,
        { data: { path: jasper.dataDir } },
      );
      expect(openResp.status()).toBe(200);

      await page.goto(jasper.baseURL);
      await expect(page.getByTestId("connection-status-dot")).toHaveAttribute(
        "data-status",
        "connected",
        { timeout: 10_000 },
      );

      const idA = await apiCreateNote(
        page,
        jasper.baseURL,
        "notes/OldTitle.md",
        "---\ntags: []\n---\n\nbody of note A (no H1 heading so filename is the title)",
      );

      await apiCreateNote(
        page,
        jasper.baseURL,
        "notes/NoteB.md",
        "---\ntags: []\n---\n\nThis links to [[oldtitle]] for context.",
      );

      const moveResp = await page.request.post(
        `${jasper.baseURL}/api/v1/notes/${idA}/move`,
        { data: { new_path: "NewTitle.md" } },
      );
      expect(moveResp.status()).toBe(200);

      await expect(page.getByRole("alert")).toBeVisible({ timeout: 8_000 });
      await expect(page.getByText("Rename failed")).toBeVisible();

      await page.getByRole("button", { name: "Dismiss error" }).click();
      await expect(page.getByRole("alert")).not.toBeVisible({ timeout: 5_000 });
    } finally {
      await jasper.kill();
    }
  });
});
