// A projection, not a domain: it owns no tables and writes nothing. It reads across six domains and
// ranks what an agent should be told first, which is why it sits at the top of the dependency order
// with nothing depending on it.

import {
  clipText,
  nowIso,
  type AgentSession,
  type CrossAgentMessage,
  type Project,
  type ReviewBundle,
  type Task,
  type TodoItem,
} from "@crossagent/protocol";
import type { StoreContext } from "./context.js";
import { getProject } from "./projects.js";
import { getSession, listSessions } from "./sessions.js";
import { getTask, listTodos } from "./tasks.js";
import { listMessages } from "./messages.js";
import { listConflicts } from "./write-intents.js";
import { listReviews } from "./reviews.js";

export function getContextPack(
  ctx: StoreContext,
  input: {
    sessionId: string;
    taskId?: string;
    files: string[];
    symbols: string[];
    maxChars: number;
  },
): {
  generatedAt: string;
  project: Project;
  objective: any;
  task: (Task & { todos: TodoItem[] }) | null;
  inbox: CrossAgentMessage[];
  decisions: any[];
  peerSessions: AgentSession[];
  conflicts: any[];
  reviews: any[];
  text: string;
  truncated: boolean;
} {
  const session = getSession(ctx, input.sessionId);
  const project = getProject(ctx, session.projectId);
  const taskId = input.taskId ?? session.currentTaskId ?? undefined;
  const task = taskId
    ? ({ ...getTask(ctx, taskId), todos: listTodos(ctx, taskId) } as Task & {
        todos: TodoItem[];
      })
    : null;
  const objective = project.activeObjectiveId
    ? ctx.sqlite.prepare("SELECT * FROM objectives WHERE id = ?").get(project.activeObjectiveId)
    : null;
  // Context packs are a read-only projection, not an ownership transition. An agent-wide
  // recipient is visible to every same-agent session in listMessages until one adapter claims it;
  // including those rows here would let multiple logical workers read the same work without ever
  // crossing the claim Seam. Only check_inbox / proactive delivery may claim, after which the
  // winning session can safely see the message in later context packs.
  const messages = listMessages(ctx, project.id, {
    agentId: session.agentId,
    sessionId: session.id,
    unread: true,
    limit: 100,
  }).filter((message) =>
    message.recipients.some(
      (recipient) =>
        recipient.recipientAgentId === session.agentId &&
        recipient.recipientSessionId === session.id,
    ),
  );
  const scored = messages
    .map((message) => {
      let score = 100;
      if (message.requiresResponse) score += 90;
      if (["BLOCKER", "CONFLICT", "REVIEW_REQUEST"].includes(message.type)) score += 80;
      if (task && message.taskId === task.id) score += 70;
      const refText = JSON.stringify(message.references);
      if (input.files.some((file) => refText.includes(file))) score += 60;
      if (input.symbols.some((symbol) => refText.includes(symbol))) score += 60;
      if (["DECISION", "PROPOSAL"].includes(message.type)) score += 50;
      score += Math.max(0, 20 - (Date.now() - Date.parse(message.createdAt)) / 3_600_000);
      return { message, score };
    })
    .sort((left, right) => right.score - left.score)
    .map((entry) => entry.message);
  const peerSessions = listSessions(ctx, project.id).filter(
    (candidate) => candidate.agentId !== session.agentId && candidate.role !== "observer",
  );
  const decisions = ctx.sqlite
    .prepare(
      "SELECT * FROM decisions WHERE project_id = ? AND status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 20",
    )
    .all(project.id);
  const conflicts = listConflicts(ctx, project.id, "OPEN").filter((conflict: any) => {
    return (
      conflict.left_session_id === session.id ||
      conflict.right_session_id === session.id ||
      (task && (conflict.left_task_id === task.id || conflict.right_task_id === task.id))
    );
  });
  const reviews = listReviews(ctx, project.id).filter(
    (review: ReviewBundle) =>
      review.taskId === task?.id ||
      review.reviewerAgentId === session.agentId ||
      review.authorAgentId === session.agentId,
  );
  const body = [
    `Project: ${project.name}`,
    objective ? `Objective: ${(objective as any).title}` : "Objective: none active",
    task ? `Task: ${task.title} [${task.status}] computed ${task.computedProgress}%` : "Task: none",
    task ? `TODO: ${task.todos.map((todo) => `${todo.status} ${todo.title}`).join(" | ")}` : "",
    `Peer: ${peerSessions
      .map(
        (peer) =>
          `${peer.agentId} ${peer.connectionState}/${peer.workState} task=${peer.currentTaskId ?? "-"}`,
      )
      .join(" | ")}`,
    `Action-required inbox:\n${scored
      .map(
        (message) =>
          `- [${message.priority}/${message.type}] ${message.summary} (message=${message.id}, thread=${message.threadId})`,
      )
      .join("\n")}`,
    `Open conflicts:\n${conflicts
      .map((conflict: any) => `- ${conflict.severity}: ${conflict.reason}`)
      .join("\n")}`,
    `Reviews:\n${reviews
      .map(
        (review: ReviewBundle) =>
          `- ${review.id} rev${review.revision} ${review.status} task=${review.taskId}`,
      )
      .join("\n")}`,
    `Decisions:\n${(decisions as any[])
      .map((decision) => `- ${decision.title}: ${decision.decision}`)
      .join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  const text = clipText(body, input.maxChars);
  return {
    generatedAt: nowIso(),
    project,
    objective,
    task,
    inbox: scored,
    decisions,
    peerSessions,
    conflicts,
    reviews,
    text,
    truncated: text.length < body.length,
  };
}
