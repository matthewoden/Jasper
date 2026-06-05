


import "@testing-library/jest-dom/vitest";


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
