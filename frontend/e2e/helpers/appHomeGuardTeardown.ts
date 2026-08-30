import { readSnapshot, snapshotRealAppJSON, REAL_APP_JSON } from "./appHomeGuard";

export default async function globalTeardown(): Promise<void> {
  const before = await readSnapshot();
  if (before === null) return; // globalSetup did not run; nothing to compare against

  const after = await snapshotRealAppJSON();
  if (before.exists === after.exists && before.sha256 === after.sha256) return;

  throw new Error(
    `E2E run modified the real app home: ${REAL_APP_JSON}\n` +
      `  before: ${before.exists ? before.sha256 : "(absent)"}\n` +
      `  after:  ${after.exists ? after.sha256 : "(absent)"}\n` +
      `A spec spawned the binary without JASPER_APP_HOME. Spawn through ` +
      `spawnJasper() (helpers/binary.ts), which allocates a per-handle app home, ` +
      `or pass env: { JASPER_APP_HOME: <tmpdir> } to a direct spawn().`,
  );
}
