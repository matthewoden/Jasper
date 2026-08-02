/**
 * useFileTree reads GET /tree off the shared resource layer. No coalescer, boot
 * fetch or subscriber set of its own — createResource owns all three now,
 * generalized from this hook's original hand-rolled version.
 *
 * Transport failures surface as snapshot.error; API-level errors surface as
 * snapshot.data.error. Both paths are preserved.
 */
import { useResource } from "./resources";
import { treeResource, type Tree } from "./treeApi";

export { walkTreeCollect } from "./treeApi";

export interface UseFileTreeResult {
  tree: Tree | null;
  loading: boolean;
  error: Error | null;
  refresh: () => Promise<void>;
}

/**
 * Trigger a tree refresh without mounting a display subscriber. Exported so
 * non-display callers (mutations, WS event handlers) can invalidate the
 * shared cache directly — every mounted useFileTree() instance picks up the
 * result via useSyncExternalStore, structurally rather than via a broadcast
 * Set.
 */
export async function broadcastRefresh(): Promise<void> {
  await treeResource.invalidate();
}

export function useFileTree(): UseFileTreeResult {
  const snapshot = useResource(treeResource);

  return {
    tree: snapshot.data?.data ?? null,
    loading: snapshot.loading,
    error: snapshot.data?.error
      ? new Error(snapshot.data.error.message)
      : snapshot.error,
    refresh: async () => {
      await treeResource.invalidate();
    },
  };
}
