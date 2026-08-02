/**
 * localStorage draft persistence for the first-run wizard, so a refresh
 * mid-wizard rehydrates the form. SetupApp clears it after a successful submit,
 * BEFORE redirecting, so the next first-run starts clean.
 *
 * localStorage throws in Safari private mode; every accessor swallows that and
 * falls back to DEFAULT_DRAFT.
 */

export const SETUP_DRAFT_KEY = "jasper.setup.draft";

export interface SetupDraft {
  dataDir: string;
  // theme dropped — dark-only; submit hardcodes "dark"
  accent: string;
  readingFont: "sans" | "serif";
  dailyTemplate: string;
  createTodayDailyNote: boolean;
}

/**
 * dataDir is empty on purpose: the wizard shows the recommendation as a
 * placeholder rather than committing a value that would bypass validation.
 *
 * dailyTemplate must use the `{{date}}` token — a literal date string was a
 * regression that wrote "# YYYY-MM-DD" verbatim into users' notes.
 */
export const DEFAULT_DRAFT: SetupDraft = {
  dataDir: "",
  accent: "purple",
  readingFont: "sans",
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
