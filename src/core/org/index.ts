export {
  OrgService,
} from './org-service.js';
export { TaskWorker } from './task-worker.js';
export type { TaskWorkerDeps } from './task-worker.js';
export type {
  OrgServiceDeps,
  OrgTaskExecutor,
  DispatchResult,
} from './org-service.js';
export { MemoryOrgStore } from './store.js';
export type { OrgSnapshot } from './store.js';

// T-M7-01 hardened execution contract
export { runTask, InMemoryActionStore } from './execution/index.js';
export {
  ExecutorError,
  ToolDeniedError,
  ExecutorTimeoutError,
  CheckpointSuspension,
  CredentialError,
  UnconfiguredSecretBackend,
  EnvSecretBackend,
  FileSecretBackend,
  ChainedSecretBackend,
  createLocalSecretBackend,
  defaultEnvName,
  resolveGrantedCredential,
  DEFAULT_RETRY_POLICY,
  DEFAULT_TASK_DEADLINE_MS,
  DEFAULT_MAX_DECISION_HOPS,
  backoffDelayMs,
  canRetry,
  deadlineExceeded,
  validateRetryPolicy,
  assertToolGranted,
  isToolGranted,
  grantedSubset,
} from './execution/index.js';
export type {
  OrgTaskExecutorV2,
  ExecutorContext,
  ExecutorCompletion,
  ExecutorDecisionRequest,
  ExecutionProgress,
  StoredProgress,
  EffectResult,
  TaskSettlement,
  RunTaskParams,
  ToolInvoker,
  DecisionPort,
  ActionResultStore,
  RetryPolicy,
  ExecutorErrorKind,
  TaskFailureKind,
  CredentialRef,
  SecretBackend,
  ResolvedCredential,
} from './execution/index.js';

export {
  ORG_ERROR_CODES,
  OrgServiceError,
} from './types.js';
export type {
  Json,
  ScaleTier,
  Organization,
  Department,
  Position,
  OrgTask,
  OrgTaskStatus,
  OrgTaskFailureKind,
  OrgTaskProgress,
  OrgTaskTransition,
  CreateOrganizationInput,
  CreateDepartmentInput,
  CreatePositionInput,
  AssignAgentInput,
  CreateOrgTaskInput,
} from './types.js';
