/**
 * fsApi — typed wrapper around GET /api/v1/fs/list (UAT-2 #1d folder picker).
 *
 * Errors propagate as thrown Error with a human-readable message; the picker
 * UI displays the message and offers "go up" to recover when a directory
 * becomes unreadable mid-browse.
 */

import { client } from "../api/client";
import type { components } from "../api/schema";

export type FsListEntry = components["schemas"]["FsListEntry"];
export type FsListResponse = components["schemas"]["FsListResponse"];

export const fsApi = {
  /**
   * GET /api/v1/fs/list?path=<abs>
   * When path is undefined the backend defaults to $HOME.
   */
  list: async (path?: string): Promise<FsListResponse> => {
    const { data, error, response } = await client.GET("/fs/list", {
      params: { query: path === undefined ? {} : { path } },
    });
    if (error || !data) {
      const body = (error as { code?: string; message?: string } | undefined) ?? {};
      const msg = body.message ?? `fs/list failed (HTTP ${response?.status ?? "?"})`;
      const err = new Error(msg) as Error & { code?: string; status?: number };
      err.code = body.code;
      err.status = response?.status;
      throw err;
    }
    return data;
  },
};
