#!/usr/bin/env node


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
