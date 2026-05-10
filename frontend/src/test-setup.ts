// Vitest setup file. Loads @testing-library/jest-dom matchers (toBeInTheDocument,
// toHaveTextContent, etc.) so they're available in every test file. Referenced
// from frontend/vite.config.ts (Plan 01) — that file already names this path.
import "@testing-library/jest-dom/vitest";

// happy-dom does not implement ResizeObserver. FileTree (and any
// component that measures layout) needs a no-op shim so render
// doesn't throw at construction. Real measurement is exercised by
// the Playwright UAT (UX-14b / UX-14c).
if (typeof globalThis.ResizeObserver === "undefined") {
  class ResizeObserverShim implements ResizeObserver {
    constructor(_cb: ResizeObserverCallback) {
      void _cb;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as unknown as { ResizeObserver: any }).ResizeObserver =
    ResizeObserverShim;
}
