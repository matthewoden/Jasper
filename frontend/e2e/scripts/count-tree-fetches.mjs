#!/usr/bin/env node
// count-tree-fetches.mjs — UX-14 verification.
// Reads the Jasper binary's stderr log from the path in argv[2], counts
// slog INFO lines with path=/api/v1/tree, prints the count, exits 0.
//
// Usage: node count-tree-fetches.mjs <log-file-path>
//
// Used by frontend/e2e/phase5_5-uat.spec.ts (Plan 05.5-09) to assert that
// a typical CRUD session (5 rapid creates) issues at most 2 GET /api/v1/tree
// requests against the running binary — proving the UX-14 single-flight
// coalescing works end-to-end, not just at the unit-test level.
//
// Contract for Plan 05.5-09's Playwright spec:
//   argv[2] = path to a captured Jasper log file (slog text format)
//   stdout  = a single integer (the count)
//   exit 0  = success
//   exit 2  = usage error (no log path supplied)
//
// Filter rule: a line counts iff it contains BOTH `path=/api/v1/tree`
// AND `status=` — the slog HTTP middleware emits one such line per
// completed request. We require `status=` to exclude any future
// non-request lines that may legitimately mention the route (e.g.
// startup banners, error messages).

import { readFileSync } from "node:fs";
import process from "node:process";

const logPath = process.argv[2];
if (!logPath) {
  console.error("usage: count-tree-fetches.mjs <log-file>");
  process.exit(2);
}

const raw = readFileSync(logPath, "utf-8");
const matches = raw.split("\n").filter(
  (line) => line.includes("path=/api/v1/tree") && line.includes("status="),
);
console.log(matches.length);
process.exit(0);
