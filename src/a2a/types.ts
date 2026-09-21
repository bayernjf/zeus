export type RealmType = 'personal' | 'enterprise';

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
  capabilities?: { streaming?: boolean; pushNotifications?: boolean; stateTransitionHistory?: boolean };
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

export type Artifact = {
  artifactId: string;
  name: string;
  parts: Array<{ kind: 'text'; text: string } | { kind: 'data'; data: Record<string, unknown> }>;
  'x-zeus-report'?: ZeusReport;
};

export type Task = {
  kind: 'task';
  id: string;
  contextId: string;
  status: { state: TaskState; timestamp?: string };
  artifacts: Artifact[];
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
