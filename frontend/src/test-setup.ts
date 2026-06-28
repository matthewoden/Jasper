


import "@testing-library/jest-dom/vitest";

// jsdom 25 does not implement PointerEvent; @testing-library uses it for
// pointerDown/Move/Up/Cancel events. Extending MouseEvent gives pointer events
// the full clientX / button / pressure / pointerId surface that components need.
if (typeof globalThis.PointerEvent === "undefined") {
  class PointerEventShim extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    readonly isPrimary: boolean;
    readonly pressure: number;
    readonly width: number;
    readonly height: number;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.pointerType = init.pointerType ?? "mouse";
      this.isPrimary = init.isPrimary ?? true;
      this.pressure = init.pressure ?? 0;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
    }
  }
  (globalThis as unknown as { PointerEvent: typeof PointerEvent }).PointerEvent =
    PointerEventShim as unknown as typeof PointerEvent;
}

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
