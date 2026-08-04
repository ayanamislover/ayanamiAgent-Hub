import { z } from "zod";

export const CONNECTION_STATES = [
  "CONNECTING",
  "ONLINE",
  "DEGRADED",
  "STALE",
  "OFFLINE",
  "CLOSED",
] as const;
export const ConnectionStateSchema = z.enum(CONNECTION_STATES);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const WORK_STATES = [
  "IDLE",
  "PLANNING",
  "WORKING",
  "RUNNING_COMMAND",
  "WAITING_FOR_PEER",
  "WAITING_FOR_USER",
  "BLOCKED",
  "REVIEWING",
  "FIXING_REVIEW",
  "COMPLETING",
  "ERROR",
] as const;
export const WorkStateSchema = z.enum(WORK_STATES);
export type WorkState = z.infer<typeof WorkStateSchema>;

export const TASK_STATUSES = [
  "BACKLOG",
  "READY",
  "CLAIMED",
  "IN_PROGRESS",
  "BLOCKED",
  "WAITING_FOR_PEER",
  "WAITING_FOR_USER",
  "REVIEW_PENDING",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "DONE",
  "CANCELLED",
] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TODO_STATUSES = ["TODO", "DOING", "DONE", "SKIPPED"] as const;
export const TodoStatusSchema = z.enum(TODO_STATUSES);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

export const MESSAGE_TYPES = [
  "STATUS",
  "TASK_PROPOSAL",
  "TASK_UPDATE",
  "QUESTION",
  "ANSWER",
  "PROPOSAL",
  "DECISION",
  "CONFLICT",
  "BLOCKER",
  "HANDOFF",
  "REVIEW_REQUEST",
  "REVIEW_RESULT",
  "FINDING_RESOLVED",
  "ARTIFACT",
  "SYSTEM",
] as const;
export const MessageTypeSchema = z.enum(MESSAGE_TYPES);
export type MessageType = z.infer<typeof MessageTypeSchema>;

export const MESSAGE_PRIORITIES = ["BACKGROUND", "NORMAL", "IMPORTANT", "INTERRUPT"] as const;
export const MessagePrioritySchema = z.enum(MESSAGE_PRIORITIES);
export type MessagePriority = z.infer<typeof MessagePrioritySchema>;

export const RECIPIENT_STATES = [
  "PENDING",
  "DELIVERED",
  "ACKNOWLEDGED",
  "PROCESSED",
  "RESPONDED",
  "EXPIRED",
  "FAILED",
] as const;
export const RecipientStateSchema = z.enum(RECIPIENT_STATES);
export type RecipientState = z.infer<typeof RecipientStateSchema>;

export const REVIEW_STATUSES = [
  "PENDING",
  "DELIVERED",
  "IN_REVIEW",
  "CHANGES_REQUESTED",
  "APPROVED",
  "SUPERSEDED",
  "CANCELLED",
] as const;
export const ReviewStatusSchema = z.enum(REVIEW_STATUSES);
export type ReviewStatus = z.infer<typeof ReviewStatusSchema>;

export const FINDING_SEVERITIES = ["info", "low", "medium", "high", "blocking"] as const;
export const FindingSeveritySchema = z.enum(FINDING_SEVERITIES);
export type FindingSeverity = z.infer<typeof FindingSeveritySchema>;

export const THREAD_STATUSES = ["OPEN", "RESOLVED", "NEEDS_USER", "ARCHIVED"] as const;
export const ThreadStatusSchema = z.enum(THREAD_STATUSES);
export type ThreadStatus = z.infer<typeof ThreadStatusSchema>;

export const AUTHORIZATION_STATUSES = [
  "PENDING",
  "GRANTED",
  "DENIED",
  "REVOKED",
  "EXPIRED",
] as const;
export const AuthorizationStatusSchema = z.enum(AUTHORIZATION_STATUSES);
export type AuthorizationStatus = z.infer<typeof AuthorizationStatusSchema>;

/**
 * Capabilities an agent must hold a user-granted authorization for. Keep this list explicit:
 * a free-form capability string would let an agent invent a permission and then satisfy it.
 */
export const AUTHORIZATION_CAPABILITIES = ["terminal.unrestricted"] as const;
export const AuthorizationCapabilitySchema = z.enum(AUTHORIZATION_CAPABILITIES);
export type AuthorizationCapability = z.infer<typeof AuthorizationCapabilitySchema>;

export const DELIVERY_MODES = [
  "native_channel",
  "app_server_push",
  "hook_poll",
  "mailbox_only",
] as const;
export const DeliveryModeSchema = z.enum(DELIVERY_MODES);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  BACKLOG: ["READY", "CANCELLED"],
  READY: ["CLAIMED", "CANCELLED"],
  CLAIMED: ["IN_PROGRESS", "READY", "CANCELLED"],
  IN_PROGRESS: ["BLOCKED", "WAITING_FOR_PEER", "WAITING_FOR_USER", "REVIEW_PENDING", "CANCELLED"],
  BLOCKED: ["IN_PROGRESS", "READY", "CANCELLED"],
  WAITING_FOR_PEER: ["IN_PROGRESS", "REVIEW_PENDING", "CANCELLED"],
  WAITING_FOR_USER: ["IN_PROGRESS", "CANCELLED"],
  REVIEW_PENDING: ["IN_REVIEW", "CHANGES_REQUESTED", "APPROVED", "CANCELLED"],
  IN_REVIEW: ["CHANGES_REQUESTED", "APPROVED"],
  CHANGES_REQUESTED: ["IN_PROGRESS", "REVIEW_PENDING"],
  APPROVED: ["DONE"],
  DONE: [],
  CANCELLED: [],
};

export const DEFAULT_PROJECT_CONFIG = {
  schemaVersion: 1,
  reviewRequiredByDefault: true,
  heartbeatIntervalSeconds: 5,
  offlineAfterSeconds: 20,
  staleClaimAfterSeconds: 120,
  idleAfterSeconds: 60,
  wakePolicy: "urgent_and_action_required",
  statusCoalesceWindowSeconds: 20,
  maxPushSummaryChars: 1600,
  maxContextPackChars: 12000,
  protectedGlobs: ["migrations/**", "src/public-api/**", "package.json", "pnpm-lock.yaml"],
  commands: {
    test: "pnpm test",
    lint: "pnpm lint",
    typecheck: "pnpm typecheck",
  },
} as const;
