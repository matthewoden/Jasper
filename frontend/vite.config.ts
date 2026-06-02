import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Phase 8 D-40: canonical port source is scripts/port.sh. Reads the
// same server.port the production binary uses (via config.json), or
// 6683 if no config exists. Keeps dev/prod parity automatic — when
// the user (or a future wizard) changes server.port in config.json,
// the Vite proxy follows without any code change here.
//
// Vite invokes execSync with cwd = frontend/ (where this file lives),
// so the script path is repo-root-relative `../scripts/port.sh`.
let PORT = "6683";
try {
  PORT = execSync("../scripts/port.sh", { encoding: "utf8" }).trim() || "6683";
} catch {
  PORT = "6683";
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: `http://127.0.0.1:${PORT}`, changeOrigin: false },
      "/ws":  { target: `http://127.0.0.1:${PORT}`, changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Plan 08-18 (R4-11 BLOCKER): honour VITE_SOURCEMAP=true so the
    // sourcemap-enabled build resolves minified symbols in DevTools.
    // Task 1c reverts this to its prior state once the investigation is
    // complete — do NOT ship sourcemaps in production builds.
    sourcemap: process.env.VITE_SOURCEMAP === "true",
  },
});
