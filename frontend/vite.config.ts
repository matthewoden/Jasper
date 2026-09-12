import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";


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
      // ws:true because the session-sync socket is /api/v1/ws — it matches this
      // rule, not a /ws one. headers.origin because csrfOriginMiddleware compares
      // the full origin including port, so the browser's :5173 Origin is refused
      // on every write. Overwriting it here keeps the dev loop working without
      // widening the shipped binary's allowlist (ADR-0027, NET-04).
      "/api": {
        target: `http://127.0.0.1:${PORT}`,
        changeOrigin: false,
        ws: true,
        headers: { origin: `http://127.0.0.1:${PORT}` },
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.VITE_SOURCEMAP === "true",
  },
});
