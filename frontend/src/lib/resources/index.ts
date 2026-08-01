/**
 * Barrel export for the shared API resource layer, so downstream call
 * sites import from "./resources" rather than reaching into individual
 * files.
 */
export { publish, subscribe } from "./eventBus";
export {
  clearAllResources,
  COALESCE_TAIL_MS,
  createKeyedResource,
  createResource,
} from "./createResource";
export type {
  MutateSpec,
  Resource,
  ResourceMode,
  ResourceOptions,
  ResourceSnapshot,
} from "./createResource";
export { useResource } from "./useResource";
