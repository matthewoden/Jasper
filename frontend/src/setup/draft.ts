/**
 * draft.ts — localStorage draft persistence for the first-run wizard.
 *
 * D-09 LOCKED: every field change on the /setup wizard writes to
 *   localStorage[SETUP_DRAFT_KEY = "jasper.setup.draft"]
 * so closing/refreshing the browser mid-wizard rehydrates the form.
 * D-10: after a successful POST /api/v1/setup, the SetupApp calls
 * clearDraft() BEFORE redirecting to "/", so a subsequent first-run
 * (in case the user wipes their data-dir and re-installs) starts fresh.
 *
 * SETUP_DRAFT_KEY is intentionally distinct from THEME_BOOTSTRAP_KEY
 * (jasper:theme-bootstrap) — the bootstrap cache survives wizard runs
 * across machines; the wizard draft is scoped to the in-flight first-run.
 *
 * Failure mode: localStorage throws in private/incognito sessions
 * (Safari) — every accessor swallows the throw and falls back to
 * DEFAULT_DRAFT / no-op, matching the pattern in useTheme.ts.
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
 * dataDir is intentionally empty: the wizard pre-fills the input's
 * `placeholder="~/Documents/Jasper"` attribute (LOCKED copy) so the
 * user sees the recommendation without it being a committed value
 * that bypasses the D-08 validation. The default theme is "dark" —
 * matches the project's existing dark-first palette in theme.css.
 *
 * dailyTemplate defaults to the `{{date}}` token —
 * backend/internal/markdown/newnote.go substitutes the actual date at
 * write time per DAILY-03. The previous literal "YYYY-MM-DD" was a
 * regression that survived strings.ReplaceAll unchanged and produced
 * literal "# YYYY-MM-DD" headers in users' daily notes instead of
 * substituted dates.
 */
export const DEFAULT_DRAFT: SetupDraft = {
  dataDir: "",
  theme: "dark",
  mcpEnabled: false,
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
 * clearDraft — remove the persisted draft entirely. Called by D-10's
 * submit-success path BEFORE window.location.assign("/") so that any
 * subsequent first-run (after a wipe-and-reinstall) starts from
 * DEFAULT_DRAFT instead of a stale half-completed form.
 */
export function clearDraft(): void {
  try {
    localStorage.removeItem(SETUP_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}
