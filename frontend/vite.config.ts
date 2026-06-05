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
      "/api": { target: `http://127.0.0.1:${PORT}`, changeOrigin: false },
      "/ws":  { target: `http://127.0.0.1:${PORT}`, changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: process.env.VITE_SOURCEMAP === "true",
  },
});
