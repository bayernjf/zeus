export type RealmType = 'personal' | 'enterprise';

/** fealty contract versions Zeus accepts at registration.
 *  A mismatched version is refused, never silently accepted (design-vassal-protocol §4.5). */
export const SUPPORTED_FEALTY_VERSIONS = ['1'] as const;

export type Fealty = {
  version: string;
  swornTo: string;
  domain: string;
  dataRealms: RealmType[];
  dataPolicy: 'none' | 'read-task-scope' | 'read-realm' | 'write';
  reportBack: boolean;
  escalationPolicy: 'none' | 'on-failure' | 'auto';
  sla?: { ackSeconds?: number };
  notes?: string;
};

export type AgentCardSkill = {
  id: string;
  name: string;
  description: string;
  tags: string[];
};

export type AgentCard = {
  name: string;
  description?: string;
  url: string;
  version?: string;
  /** Standard A2A provider descriptor (present on pr-helper/loom cards). */
  provider?: { organization: string; url: string };
  capabilities?: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean };
  /** Standard A2A I/O mode declarations, e.g. ['application/json']. */
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  skills: AgentCardSkill[];
  authentication?: { schemes?: string[] };
  preferredTransport?: string;
  'x-zeus-fealty'?: Fealty;
};

export type TaskState =
  | 'submitted'
  | 'working'
  | 'input-required'
  | 'completed'
  | 'failed'
  | 'canceled';

export type ZeusReport = {
  summary: string;
  evidence: string[];
  cost: { llmTokens: number; wallSeconds: number };
  followUps: Array<{ skill: string; reason: string }>;
};

export type TextPart = { kind: 'text'; text: string };
export type DataPart = { kind: 'data'; data: Record<string, unknown> };
/**
 * Standard A2A FilePart (reference form). Zeus v1 only passes file URIs through
 * to the driver — it never fetches them itself (SSRF / local-file boundary) and
 * never inlines bytes. `bytes` (base64) is kept on the type for wire
 * compatibility but is not emitted by Zeus v1.
 */
export type FilePart = {
  kind: 'file';
  file: { uri: string; name?: string; mimeType?: string; bytes?: string };
};
export type Part = TextPart | DataPart | FilePart;

export type Artifact = {
  artifactId: string;
  name: string;
  parts: Part[];
  'x-zeus-report'?: ZeusReport;
};

export type Task = {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp?: string };
  artifacts: Artifact[];
  /**
   * Standard A2A state-transition history (capability stateTransitionHistory).
   * Loosely typed and passed through verbatim: Zeus v1 never parses it (loom
   * omits it; pr-helper emits it).
   */
  history?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
};

export type A2AEvent =
  | {
      kind: 'status-update';
      taskId: string;
      contextId: string;
      status: { state: TaskState; timestamp?: string };
      final: boolean;
      'x-zeus'?: { runId: string };
      'x-zeus-escalation'?: { level: string; reason: string; options: string[] };
    }
  | {
      kind: 'artifact-update';
      taskId: string;
      contextId: string;
      artifact: Artifact;
      final?: boolean;
      'x-zeus'?: { runId: string };
    };
