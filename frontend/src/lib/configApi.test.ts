/**
 * configApi.test — the fetch/mutation wrappers configApi.ts owns:
 * configResource's boot-scoped coalescing and lastPersisted's
 * update-on-success / untouched-on-failure contract (the base saveConfig's
 * rollback reads).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api/client", () => ({
  client: {
    GET: vi.fn(),
    PUT: vi.fn(),
    PATCH: vi.fn(),
  },
}));

import { client } from "../api/client";
import { __testing__ as resourcesTesting } from "./resources/createResource";
import {
  __testing__ as configApiTesting,
  configResource,
  getLastPersisted,
  patchConfig,
  putConfig,
} from "./configApi";
import type { Config } from "./configApi";

const mockClient = client as unknown as {
  GET: ReturnType<typeof vi.fn>;
  PUT: ReturnType<typeof vi.fn>;
  PATCH: ReturnType<typeof vi.fn>;
};

const sampleConfig = {
  appName: "Jasper",
  theme: "dark" as const,
  accent: "purple" as const,
  readingFont: "sans" as const,
  dailyNotes: { template: "" },
  editor: {
    fontSize: 15,
    lineHeight: 1.6,
    autosaveMs: 2000,
    showProperties: true,
    autoPair: true,
    foldGutter: true,
    lineNumbers: false,
    lineWidth: 700,
  },
} as unknown as Config;

beforeEach(() => {
  mockClient.GET.mockReset();
  mockClient.PUT.mockReset();
  mockClient.PATCH.mockReset();
  resourcesTesting.reset();
  configApiTesting.reset();
});

describe("configApi", () => {
  it("three configResource.read() calls resolve from one client.GET (boot-scoped)", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });

    const [a, b, c] = await Promise.all([
      configResource.read(),
      configResource.read(),
      configResource.read(),
    ]);

    expect(mockClient.GET).toHaveBeenCalledTimes(1);
    expect(a).toEqual(sampleConfig);
    expect(b).toEqual(sampleConfig);
    expect(c).toEqual(sampleConfig);
  });

  it("a patchConfig response updates lastPersisted", async () => {
    expect(getLastPersisted()).toBeNull();
    mockClient.PATCH.mockResolvedValue({
      data: { ...sampleConfig, theme: "light" },
      response: { status: 200 },
    });

    await patchConfig({ theme: "light" });

    expect(getLastPersisted()?.theme).toBe("light");
  });

  it("a failing patch leaves lastPersisted untouched", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    await configResource.read();
    expect(getLastPersisted()).toEqual(sampleConfig);

    mockClient.PATCH.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    await patchConfig({ theme: "light" });

    expect(getLastPersisted()).toEqual(sampleConfig);
  });

  it("a failing put leaves lastPersisted untouched", async () => {
    mockClient.GET.mockResolvedValue({ data: sampleConfig, response: { status: 200 } });
    await configResource.read();

    mockClient.PUT.mockResolvedValue({
      error: { code: "invalid_request", message: "bad" },
      response: { status: 400 },
    });
    await putConfig({ ...sampleConfig, theme: "light" });

    expect(getLastPersisted()).toEqual(sampleConfig);
  });

  it("a GET failure throws — configResource.read() rejects, entry.error carries the ApiError shape", async () => {
    mockClient.GET.mockResolvedValue({
      error: { code: "unauthorized", message: "no" },
      response: { status: 401 },
    });

    await expect(configResource.read()).rejects.toThrow();
    const snapshot = configResource.peek();
    expect((snapshot.error as unknown as { code: string }).code).toBe("unauthorized");
    expect((snapshot.error as unknown as { status: number }).status).toBe(401);
  });
});
