/**
 * Run-level guard: the real ~/.jasper/app.json must be byte-identical before
 * and after the suite.
 *
 * Every spawned binary resolves its app home from JASPER_APP_HOME, falling back
 * to ~/.jasper. A spec that spawns without setting it registers its throwaway
 * vault in the developer's real recent-vault list, which is capped at 10 — so a
 * full run silently evicts every genuine entry. Isolation lives in
 * spawnJasper(); this guard is what catches the next spec that bypasses it.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

const REAL_APP_JSON = path.join(homedir(), ".jasper", "app.json");
const STASH = path.join(tmpdir(), "jasper-e2e-apphome-guard.json");

interface Snapshot {
  exists: boolean;
  sha256: string | null;
}

export async function snapshotRealAppJSON(): Promise<Snapshot> {
  try {
    const buf = await readFile(REAL_APP_JSON);
    return { exists: true, sha256: createHash("sha256").update(buf).digest("hex") };
  } catch {
    return { exists: false, sha256: null };
  }
}

export async function writeSnapshot(snap: Snapshot): Promise<void> {
  await writeFile(STASH, JSON.stringify(snap), "utf8");
}

export async function readSnapshot(): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(STASH, "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

export { REAL_APP_JSON };

export default async function globalSetup(): Promise<void> {
  await writeSnapshot(await snapshotRealAppJSON());
}
