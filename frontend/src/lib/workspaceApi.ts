/**
 * workspaceApi — typed wrappers over the /vault/workspace endpoint pair.
 * All calls route through the openapi-fetch client; no hand-written request shapes.
 *
 * Endpoints:
 *   GET /api/v1/vault/workspace → getWorkspace(): Workspace
 *   PUT /api/v1/vault/workspace → putWorkspace(patch): Workspace
 *
 * Both wrappers throw on non-2xx (mirrors bookmarksApi.ts's unwrapErrorMessage
 * + throw-on-error contract) so callers can use try/catch.
 */

import { client } from "../api/client";
import { createResource } from "./resources";
import type { components } from "../api/schema";

export type Workspace = components["schemas"]["Workspace"];

function unwrapErrorMessage(error: unknown, fallback: string): string {
  return error && typeof error === "object" && "message" in error
    ? String((error as { message: unknown }).message)
    : fallback;
}

async function getWorkspace(): Promise<Workspace> {
  const { data, error } = await client.GET("/vault/workspace");
  if (error || !data) {
    throw new Error(unwrapErrorMessage(error, "could not load workspace"));
  }
  return data;
}

export const workspaceResource = createResource("workspace", getWorkspace, {
  mode: "cached",
  invalidatedBy: ["workspace:changed"],
});

export async function putWorkspace(
  patch: Partial<Workspace>,
): Promise<Workspace> {
  const { data, error } = await client.PUT("/vault/workspace", {
    body: patch,
  });
  if (error || !data) {
    throw new Error(unwrapErrorMessage(error, "could not save workspace"));
  }
  return data;
}
