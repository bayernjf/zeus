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

// F4.2 experience candidates (auto stage + human review gate)
export {
  MemoryExperienceStore,
  deriveCandidateDrafts,
  catalogWithAdvisories,
} from './experience/index.js';
export type {
  ExperienceStore,
  ExperienceCandidate,
  ExperienceCandidateKind,
  PositionSopView,
  SopAdvisory,
} from './experience/index.js';

// F5.2 in-process scheduling over registered goals
export { CronOrgScheduler, goalOccurrence, goalRunKey } from './scheduling/index.js';
export type {
  CronOrgSchedulerDeps,
  OrgScheduleDelivery,
  OrgScheduleTickResult,
  OrgScheduler,
} from './scheduling/index.js';

// F5.3 built-in goal templates (code-owned catalog + expansion)
export {
  GOAL_TEMPLATES,
  expandGoalSteps,
  goalTemplateById,
  listGoalTemplates,
  validateGoalTemplate,
} from './goal-templates.js';
export type { ExpandedGoalStep } from './goal-templates.js';

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

// T-M7-03 SOP/skill catalog + grade-scope guard
export {
  SKILL_IDS,
  SOP_CATALOG,
  TOOL_DEFAULT_GRADE,
  GRADE_RAISE_ARG,
  gradeAtLeast,
  maxGrade,
  requiredGradeForTool,
  sopBySkill,
  sopByWorkflow,
  catalogTools,
  fitPositionToSop,
} from './sop/index.js';
export type { PositionSop, SopStep, PositionSopFit } from './sop/index.js';
export { GradeDeniedError, coverageCeil } from './execution/index.js';

// T-M7-02 agent-world adapter (the first real ToolInvoker/executor).
export {
  AgentWorldClient,
  AgentWorldApiError,
  AgentWorldAuthRequired,
  AgentWorldToolInvoker,
  AgentWorldOrgTaskExecutor,
  AGENT_WORLD_TOOLS,
  AGENT_WORLD_LOGIN_REF,
} from './adapters/agent-world/index.js';
// F1.3 agent-dev adapter (the second real ToolInvoker/executor).
export {
  AgentDevClient,
  AgentDevApiError,
  AgentDevToolInvoker,
  AgentDevOrgTaskExecutor,
  AGENT_DEV_TOOLS,
} from './adapters/agent-dev/index.js';
export type {
  AgentWorldClientOptions,
  AgentWorldLogin,
  AgentWorldRunView,
  AgentWorldRunStatus,
  AgentWorldArtifactRef,
  AgentWorldToolInvokerOptions,
  AgentWorldWorkflow,
  AgentWorldTaskPayload,
  AgentWorldOrgTaskExecutorOptions,
} from './adapters/agent-world/index.js';
export type {
  AgentDevClientOptions,
  AgentDevRunStatus,
  AgentDevFeatureTask,
  AgentDevRuntimeRun,
  AgentDevGitEvidence,
  AgentDevLastCommit,
  GetFeatureTaskArgs,
  PrepareRuntimeArgs,
  ExecuteRuntimeArgs,
  AgentDevToolInvokerOptions,
  AgentDevTaskPayload,
} from './adapters/agent-dev/index.js';
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
  OrgTaskOutcome,
  CreateOrganizationInput,
  CreateDepartmentInput,
  CreatePositionInput,
  AssignAgentInput,
  CreateOrgTaskInput,
  OrgGoal,
  OrgGoalPeriod,
  OrgGoalStatus,
  OrgGoalSchedule,
  OrgGoalTaskTemplate,
  OrgGoalTemplate,
  OrgGoalTemplateStep,
  CreateOrgGoalInput,
  UpdateOrgGoalInput,
} from './types.js';

// F1.2 workspace isolation
export { GitWorktreeManager } from './workspace/git-worktree.js';
export type { GitWorktreeManagerOptions } from './workspace/git-worktree.js';
export { WorkspaceError } from './workspace/manager.js';
export type {
  AcquiredWorkspace,
  WorkspaceManager,
  WorkspacePolicy,
  WorkspaceRequest,
} from './workspace/manager.js';
