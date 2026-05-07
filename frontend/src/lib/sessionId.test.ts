import { afterEach, describe, expect, it } from "vitest";
import { generateOrLoadSessionId } from "./sessionId";

describe("generateOrLoadSessionId", () => {
  afterEach(() => sessionStorage.clear());

  it("returns a UUID and persists it across calls", () => {
    const a = generateOrLoadSessionId();
    const b = generateOrLoadSessionId();
    expect(a).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(a).toBe(b);
  });

  it("generates a fresh UUID after sessionStorage is cleared", () => {
    const a = generateOrLoadSessionId();
    sessionStorage.clear();
    const b = generateOrLoadSessionId();
    expect(a).not.toBe(b);
  });
});
