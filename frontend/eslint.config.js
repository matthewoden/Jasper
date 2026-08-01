import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/api/schema.d.ts"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
    },
  },
  // Phase 32.2 (D-16/D-18/D-19): the resource layer is the only place allowed
  // to talk to the network client directly. Everything else — components,
  // hooks, editor modules, stores — imports a named wrapper from a `*Api.ts`
  // module (or a `useResource`/`useXxx` hook built on one), never `client` or
  // `openapi-fetch` itself. Structural enforcement (GET fetchers are
  // module-private) is the first line; this is the lint backstop (D-16).
  //
  // Zero exemptions beyond the four allowlist globs below (production
  // source), and no eslint-disable convention (D-18) — the only way past
  // this rule is editing this config, which is the deliberate, reviewable
  // act D-02 asks for. Severity is `error`, not `warn` (D-19): `lefthook.yml`
  // already runs `make lint` pre-commit, so this needs no new hook wiring.
  //
  // `**/*.test.{ts,tsx}` is also excluded: several pre-existing test files
  // (configApi.test.ts, searchApi.test.ts, revealApi.test.ts,
  // vaultAboutApi.test.ts, useConfig.test.ts, useAccent.test.ts,
  // SettingsDialogShell.test.tsx) `vi.mock("../api/client", ...)` to stub
  // the network boundary directly, a white-box testing pattern that
  // predates this phase. That is not the defect class this rule targets —
  // T-32.2-20 is about PRODUCTION code bypassing the shared cache; a test
  // double never ships to the browser. Rewriting seven files' mocking
  // strategy to route through `*Api.ts` wrappers instead is out of this
  // plan's scope and not required to close D-16/D-18/D-19, whose acceptance
  // bar is the production import boundary.
  {
    files: ["**/*.{ts,tsx}"],
    ignores: [
      "src/api/**",
      "src/lib/*Api.ts",
      "src/lib/resources/**",
      "src/setup/setupApi.ts",
      "**/*.test.ts",
      "**/*.test.tsx",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/api/client", "*/api/client", "../api/client", "./api/client"],
              message:
                "Components/hooks may not import the network client directly. GET calls belong in a `*Api.ts` module registered with `createResource` (see frontend/src/lib/resources/) — import the resource's hook instead.",
            },
            {
              group: ["openapi-fetch"],
              message:
                "Only frontend/src/api/client.ts constructs the openapi-fetch client. Import a `*Api.ts` module's wrapper instead.",
            },
          ],
        },
      ],
    },
  },
);
