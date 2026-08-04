import type { MessagePriority, TaskStatus } from "./constants.js";
import { TASK_TRANSITIONS } from "./constants.js";
import type { ReviewFinding, TodoItem } from "./schemas.js";

export function nowIso(date = new Date()): string {
  return date.toISOString();
}

function secureRandomBytes(size: number): Uint8Array {
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("A Web Crypto compatible secure random source is required");
  }
  return crypto.getRandomValues(new Uint8Array(size));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function base64Url(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index]!;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    encoded += alphabet[first >> 2];
    encoded += alphabet[((first & 0x03) << 4) | ((second ?? 0) >> 4)];
    if (second !== undefined) {
      encoded += alphabet[((second & 0x0f) << 2) | ((third ?? 0) >> 6)];
    }
    if (third !== undefined) encoded += alphabet[third & 0x3f];
  }
  return encoded;
}

export function createId(prefix: string): string {
  const time = Date.now().toString(36).padStart(10, "0");
  const entropy = hex(secureRandomBytes(8));
  return `${prefix}_${time}${entropy}`;
}

export function createOpaqueToken(): string {
  return base64Url(secureRandomBytes(64));
}

export function assertTaskTransition(from: TaskStatus, to: TaskStatus): void {
  if (from === to) return;
  if (!TASK_TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid task transition: ${from} -> ${to}`);
  }
}

export function computeTaskProgress(
  todos: Pick<TodoItem, "status" | "weight">[],
  reviewRequired: boolean,
  reviewApproved: boolean,
  findings: Pick<ReviewFinding, "blocking" | "status">[] = [],
): number {
  const included = todos.filter((todo) => todo.status !== "SKIPPED");
  const total = included.reduce((sum, todo) => sum + todo.weight, 0);
  const done = included
    .filter((todo) => todo.status === "DONE")
    .reduce((sum, todo) => sum + todo.weight, 0);
  const implementationRatio = total === 0 ? 0 : done / total;
  const implementationCap = reviewRequired ? 85 : 100;
  let progress = implementationRatio * implementationCap;
  if (reviewRequired && reviewApproved) progress += 15;
  const hasBlocking = findings.some(
    (finding) => finding.blocking && !["VERIFIED", "WONT_FIX"].includes(finding.status),
  );
  if (hasBlocking) progress = Math.min(progress, 99);
  return Math.round(Math.max(0, Math.min(100, progress)) * 10) / 10;
}

export type AgentPushState = {
  activeTurn: boolean;
  online: boolean;
  atSafeCheckpoint: boolean;
  wakePolicy: "interrupt_only" | "urgent_and_action_required" | "never";
};

export type PushAction = "mailbox" | "queue" | "steer" | "inject" | "wake";

export function choosePushAction(priority: MessagePriority, state: AgentPushState): PushAction {
  if (priority === "BACKGROUND") return "mailbox";
  if (!state.online) return "mailbox";
  if (state.activeTurn) {
    if (priority === "INTERRUPT") return "steer";
    if (priority === "IMPORTANT") return state.atSafeCheckpoint ? "steer" : "queue";
    return "queue";
  }
  // NORMAL used to inject here. `thread/inject_items` puts the message in the thread but wakes
  // nothing, so the peer only saw it the next time a human typed -- and on codex-cli 0.145.0
  // nothing can read the item back to confirm it landed (`thread/read` returns metadata only,
  // `thread/items/list` answers "not supported yet"). Measured: every NORMAL message sat PENDING
  // forever while the identical IMPORTANT one was delivered in four seconds. Reaching an idle peer
  // means starting a turn.
  if (priority === "NORMAL") return "wake";
  if (priority === "INTERRUPT") return "wake";
  // A peer that opted out of being woken still gets injected rather than pushed, which remains
  // unconfirmable on 0.145.0; the message stays replayable instead of being reported delivered.
  return state.wakePolicy === "urgent_and_action_required" ? "wake" : "inject";
}

export function clipText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, Math.max(0, maxChars - 40))}\n… ${omitted} characters omitted`;
}
