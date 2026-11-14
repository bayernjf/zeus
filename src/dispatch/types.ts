// Executor directory types live with the registry (A1); re-exported here so
// dispatch-side code keeps importing them from the dispatch surface.
export type { ExecutorLike, ExecutorLookup, ExecutorStatus } from '../registry/registry.js';
