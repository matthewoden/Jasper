/**
 * filesApi — STUB for RED commit (Plan 07-34). Real implementation lands in
 * the GREEN commit below.
 *
 * Per CLAUDE.md "TDD execution" — RED commits should fail by assertion, not
 * by import resolution. Exporting the contract surface from the stub lets the
 * test file load + run + fail at the assertion layer.
 */

export interface UploadFileResult {
  path: string;
  name: string;
  size_bytes: number;
  content_type?: string;
}

export async function uploadFile(
  targetDir: string,
  file: File,
): Promise<UploadFileResult> {
  // Stub touch so eslint's no-unused-vars doesn't fire (preserves the
  // typed signature for the GREEN swap-in).
  void targetDir;
  void file;
  throw new Error("filesApi.uploadFile: not implemented (Plan 07-34 stub)");
}
