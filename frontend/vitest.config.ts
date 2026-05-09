import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    // Default jsdom URL is "about:blank" which has no origin, so any
    // relative-URL fetch (e.g. openapi-fetch with baseUrl: "/api/v1")
    // throws "Invalid URL" inside whatwg-url. Set an explicit origin so
    // relative URLs resolve as they do in a real browser.
    environmentOptions: {
      jsdom: { url: "http://localhost/" },
    },
    globals: true,
    setupFiles: ["./src/test-setup.ts"],
    // Vitest's default include matches `**/*.{test,spec}.?(c|m)[jt]s?(x)`,
    // which would pull the Playwright e2e spec under `e2e/` into the
    // vitest run. Plan 03-15 introduced `frontend/e2e/*.spec.ts` for
    // Playwright. We exclude that directory explicitly so `npm test` /
    // `vitest --run` continue to test only the jsdom-bound suites in
    // `src/`. (The default exclude already covers `node_modules` and
    // `dist`; we additively name `e2e` rather than re-stating defaults.)
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
  },
});
