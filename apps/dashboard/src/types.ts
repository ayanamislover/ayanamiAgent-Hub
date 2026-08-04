import type {
  AgentSession,
  CrossAgentMessage,
  DomainEvent,
  Project,
  ReviewBundle,
  Task,
} from "@crossagent/protocol";

export type ObjectiveView = {
  id: string;
  title: string;
  description: string;
  definition_of_done?: string[];
  definitionOfDone?: string[];
  status: string;
  updated_at?: string;
  updatedAt?: string;
} | null;

export type MilestoneView = {
  id: string;
  title: string;
  description: string;
  status: string;
  computedProgress: number;
  taskCount: number;
};

export type ConflictView = {
  id: string;
  severity: "low" | "medium" | "high" | "critical";
  status: string;
  overlapFiles: string[];
  overlapSymbols: string[];
  createdAt: string;
  left: { agentId: string; taskId: string; globs: string[] };
  right: { agentId: string; taskId: string; globs: string[] };
};

export type ReviewView = ReviewBundle & {
  findings?: Array<{
    id: string;
    severity: string;
    title: string;
    impact: string;
    status: string;
    blocking: boolean;
    filePath: string | null;
  }>;
};

export type Overview = {
  project: Project;
  objective: ObjectiveView;
  computedProgress: number;
  milestones: MilestoneView[];
  tasks: Task[];
  sessions: AgentSession[];
  pendingReviews: ReviewBundle[];
  blockers: Task[];
  conflicts: ConflictView[];
  decisions: Array<Record<string, unknown>>;
  recentEvents: DomainEvent[];
  currentSequence: number;
  generatedAt: string;
};

export type Metrics = {
  activeSessions: number;
  maxHeartbeatLagMs: number;
  pendingMessages: number;
  actionRequiredAgeSeconds: number;
  taskCounts: Array<{ status: string; count: number }>;
  blockingFindings: number;
  writeConflicts: number;
  websocketClients: number;
  adapterReconnects: number;
  dbBusyRetries: number;
  generatedAt: string;
};

export type MessageView = CrossAgentMessage;
