/**
 * draft.ts — localStorage draft persistence for the first-run wizard.
 *
 * Every field change on the /setup wizard writes to
 * localStorage[SETUP_DRAFT_KEY] so closing/refreshing mid-wizard rehydrates
 * the form. After a successful POST /api/v1/setup, SetupApp calls
 * clearDraft() BEFORE redirecting to "/" so a subsequent first-run starts
 * fresh.
 *
 * SETUP_DRAFT_KEY is distinct from THEME_BOOTSTRAP_KEY — the bootstrap cache
 * survives wizard runs; the draft is scoped to the in-flight first-run only.
 *
 * Failure mode: localStorage throws in private/incognito sessions (Safari);
 * every accessor swallows the throw and falls back to DEFAULT_DRAFT / no-op,
 * matching the pattern in useTheme.ts.
 */

export const SETUP_DRAFT_KEY = "jasper.setup.draft";

export interface SetupGrantDraft {
  folder: string;
  level: 1 | 2;
}

export interface SetupDraft {
  dataDir: string;
  theme: "dark" | "light";
  mcpEnabled: boolean;
  mcpGrants: SetupGrantDraft[];
  dailyTemplate: string;
  createTodayDailyNote: boolean;
}

/**
 * DEFAULT_DRAFT — initial wizard state before any user input.
 *
 * dataDir is empty: the wizard pre-fills the input's placeholder so the
 * user sees the recommendation without committing a value that bypasses
 * directory validation. Default theme is "dark" (dark-first palette).
 *
 * dailyTemplate uses the `{{date}}` token — the backend substitutes the
 * actual date at write time. Using a literal date string was a regression
 * that produced "# YYYY-MM-DD" headers verbatim in users' daily notes.
 */
export const DEFAULT_DRAFT: SetupDraft = {
  dataDir: "",
  theme: "dark",
  mcpEnabled: true,
  mcpGrants: [],
  dailyTemplate: "# {{date}}\n\n",
  createTodayDailyNote: false,
};

/**
 * loadDraft — read the persisted wizard state, falling back to
 * DEFAULT_DRAFT when no draft exists, when JSON.parse throws, or
 * when localStorage is unavailable (private mode).
 *
 * Shallow-merges parsed data into DEFAULT_DRAFT so older drafts
 * missing newer fields still load cleanly when the schema evolves.
 */
export function loadDraft(): SetupDraft {
  try {
    const raw = localStorage.getItem(SETUP_DRAFT_KEY);
    if (!raw) return { ...DEFAULT_DRAFT };
    const parsed = JSON.parse(raw) as Partial<SetupDraft> | null;
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_DRAFT };
    return { ...DEFAULT_DRAFT, ...parsed };
  } catch {
    return { ...DEFAULT_DRAFT };
  }
}

/**
 * saveDraft — patch the persisted wizard state with the provided
 * partial. Reads the existing draft, merges, and writes back. Calls
 * are synchronous and silently no-op when localStorage is unavailable
 * (private mode); the wizard remains interactive even when the draft
 * can't be persisted — the user just won't see rehydration on refresh.
 */
export function saveDraft(patch: Partial<SetupDraft>): void {
  try {
    const prev = loadDraft();
    const next: SetupDraft = { ...prev, ...patch };
    localStorage.setItem(SETUP_DRAFT_KEY, JSON.stringify(next));
  } catch {
    /* private/incognito mode — fall through silently (see useTheme.ts) */
  }
}

/**
 * clearDraft — remove the persisted draft entirely. Called on submit-success
 * BEFORE window.location.assign("/") so any subsequent first-run starts from
 * DEFAULT_DRAFT rather than a stale half-completed form.
 */
export function clearDraft(): void {
  try {
    localStorage.removeItem(SETUP_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
