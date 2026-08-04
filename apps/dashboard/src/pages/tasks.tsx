import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Check, DotsThree, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { Background, Controls, ReactFlow, type Edge, type Node } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { Task } from "@crossagent/protocol";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { hub, idempotency } from "../api.js";
import { EmptyState, Panel, Pill, ProgressBar } from "../components/primitives.js";
import { Select } from "../components/select.js";
import { useUi } from "../store.js";
import type { Overview } from "../types.js";
import { t } from "../i18n.js";

const COLUMNS = [
  { key: "READY", label: t("Ready") },
  { key: "ACTIVE", label: t("In flight") },
  { key: "REVIEW", label: t("Review") },
  { key: "DONE", label: t("Done") },
] as const;

function column(task: Task): (typeof COLUMNS)[number]["key"] {
  if (task.status === "READY" || task.status === "BACKLOG") return "READY";
  if (["REVIEW_PENDING", "IN_REVIEW", "CHANGES_REQUESTED", "APPROVED"].includes(task.status))
    return "REVIEW";
  if (["DONE", "CANCELLED"].includes(task.status)) return "DONE";
  return "ACTIVE";
}

function tone(task: Task): "neutral" | "cyan" | "amber" | "red" | "green" {
  if (task.status === "DONE") return "green";
  if (task.status === "BLOCKED" || task.priority === "critical") return "red";
  if (task.status.includes("REVIEW")) return "amber";
  if (task.ownerAgentId) return "cyan";
  return "neutral";
}

function TaskCard({ task }: { task: Task }) {
  const select = useUi((state) => state.setSelectedTaskId);
  return (
    <button
      className="task-card"
      type="button"
      aria-haspopup="dialog"
      aria-label={t("Inspect task: {title}", { title: task.title })}
      onClick={() => select(task.id)}
    >
      <div className="task-card-top">
        <Pill tone={tone(task)}>{task.status.replaceAll("_", " ")}</Pill>
        <DotsThree size={19} aria-hidden="true" />
      </div>
      <h3>{task.title}</h3>
      <p>{task.description || t("No implementation note supplied.")}</p>
      <div className="task-tags">
        {task.capabilityTags.slice(0, 3).map((tag) => (
          <span key={tag}>{tag}</span>
        ))}
      </div>
      <ProgressBar value={task.computedProgress} label={t("Evidence")} />
      <footer>
        <span>{task.ownerAgentId ?? t("Unclaimed")}</span>
        <code>{task.id.slice(-8)}</code>
      </footer>
    </button>
  );
}

function TaskInspector({ projectId }: { projectId: string }) {
  const selected = useUi((state) => state.selectedTaskId);
  const close = useUi((state) => state.setSelectedTaskId);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const queryClient = useQueryClient();
  const task = useQuery({
    queryKey: ["task", selected],
    queryFn: () =>
      hub.request<Task & { todos: Array<Record<string, unknown>> }>(
        "GET",
        `/api/tasks/${selected}`,
      ),
    enabled: Boolean(selected),
  });
  const mutation = useMutation({
    mutationFn: async (status: string) => {
      if (!task.data) return;
      return hub.updateTask(task.data.id, {
        expectedVersion: task.data.version,
        status,
        idempotencyKey: idempotency("dashboard-task"),
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["project", projectId] });
      void queryClient.invalidateQueries({ queryKey: ["task", selected] });
    },
  });
  const dismiss = () => {
    close(null);
    window.requestAnimationFrame(() => {
      const previous = previouslyFocused.current;
      const target = previous?.isConnected
        ? previous
        : document.querySelector<HTMLElement>(".task-card");
      target?.focus();
    });
  };

  useEffect(() => {
    if (!selected) return;
    previouslyFocused.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    mutation.reset();
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [selected]);

  if (!selected) return null;
  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) dismiss();
      }}
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={task.data ? undefined : t("Task inspector")}
        aria-labelledby={task.data ? "task-inspector-title" : undefined}
        aria-busy={task.isLoading || mutation.isPending}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          ref={closeButtonRef}
          className="drawer-close"
          type="button"
          aria-label={t("Close task inspector")}
          onClick={dismiss}
        >
          <X size={18} />
        </button>
        {task.isLoading ? (
          <div className="empty-state" role="status" aria-live="polite">
            <strong>{t("Loading task")}</strong>
            <span>{t("Retrieving the latest version and acceptance evidence…")}</span>
          </div>
        ) : task.error ? (
          <div className="error-state" role="alert">
            <div>
              <strong>{t("Unable to load this task")}</strong>
              <span>{task.error.message}</span>
              <button className="primary-button" type="button" onClick={() => void task.refetch()}>
                {t("Try again")}
              </button>
            </div>
          </div>
        ) : task.data ? (
          <>
            <span className="eyebrow">{task.data.id}</span>
            <h2 id="task-inspector-title">{task.data.title}</h2>
            <p>{task.data.description || t("No implementation note supplied.")}</p>
            <div className="drawer-meta">
              <div>
                <span>{t("Status")}</span>
                <strong>{task.data.status}</strong>
              </div>
              <div>
                <span>{t("Owner")}</span>
                <strong>{task.data.ownerAgentId ?? t("Unclaimed")}</strong>
              </div>
              <div>
                <span>{t("Reviewer")}</span>
                <strong>{task.data.reviewerAgentId ?? t("Unassigned")}</strong>
              </div>
              <div>
                <span>{t("Version")}</span>
                <strong>v{task.data.version}</strong>
              </div>
            </div>
            <ProgressBar value={task.data.computedProgress} />
            <h3 className="drawer-section-title">{t("Acceptance TODO")}</h3>
            <div className="todo-list" role="list" aria-label={t("Acceptance TODO")}>
              {task.data.todos.map((todo) => (
                <div key={String(todo.id)} role="listitem">
                  <span className={todo.status === "DONE" ? "done" : ""}>
                    {todo.status === "DONE" ? <Check size={13} /> : null}
                  </span>
                  <div>
                    <strong>{String(todo.title)}</strong>
                    <small>
                      {String(todo.status).replaceAll("_", " ")} · {String(todo.type)}
                    </small>
                  </div>
                </div>
              ))}
              {task.data.todos.length === 0 && (
                <span className="muted">{t("No TODO evidence.")}</span>
              )}
            </div>
            <h3 className="drawer-section-title">{t("State transition")}</h3>
            <div className="button-grid" role="group" aria-label={t("Task state transition")}>
              {["IN_PROGRESS", "BLOCKED", "REVIEW_PENDING", "CANCELLED"].map((status) => (
                <button
                  key={status}
                  type="button"
                  disabled={mutation.isPending || task.data?.status === status}
                  aria-label={t("Move task to {status}", {
                    status: status.replaceAll("_", " "),
                  })}
                  onClick={() => mutation.mutate(status)}
                >
                  {status.replaceAll("_", " ")}
                </button>
              ))}
            </div>
            {mutation.error && (
              <span className="project-register-error" role="alert">
                {mutation.error.message}
              </span>
            )}
          </>
        ) : (
          <div className="empty-state">
            <strong>{t("Task unavailable")}</strong>
            <span>{t("The selected task no longer exists or is outside this project.")}</span>
          </div>
        )}
      </aside>
    </div>
  );
}

function CreateTaskDialog({
  open,
  overview,
  onClose,
}: {
  open: boolean;
  overview: Overview;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<Task["priority"]>("normal");
  const [status, setStatus] = useState<"BACKLOG" | "READY">("READY");
  const queryClient = useQueryClient();
  const select = useUi((state) => state.setSelectedTaskId);
  const mutation = useMutation({
    mutationFn: async () => {
      if (!overview.objective)
        throw new Error(t("Create an active objective before adding tasks."));
      return hub.request<Task>("POST", `/api/projects/${overview.project.id}/tasks`, {
        objectiveId: overview.objective.id,
        milestoneId: overview.milestones[0]?.id ?? null,
        title: title.trim(),
        description: description.trim(),
        status,
        priority,
        capabilityTags: [],
        scopeGlobs: [],
        protectedScope: false,
        reviewRequired: true,
        dependsOn: [],
        weight: 1,
        idempotencyKey: idempotency("dashboard-create-task"),
      });
    },
    onSuccess: async (task) => {
      await queryClient.invalidateQueries({ queryKey: ["project", overview.project.id] });
      setTitle("");
      setDescription("");
      select(task.id);
      onClose();
    },
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      mutation.reset();
      dialog.showModal();
      window.requestAnimationFrame(() => titleInputRef.current?.focus());
    }
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (title.trim()) mutation.mutate();
  };

  return (
    <dialog
      ref={dialogRef}
      className="project-manager-dialog"
      aria-labelledby="create-task-title"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
    >
      <header>
        <div>
          <span className="eyebrow">{t("Work orchestration")}</span>
          <h2 id="create-task-title">{t("Create task")}</h2>
        </div>
        <button
          className="icon-button"
          type="button"
          aria-label={t("Close task form")}
          onClick={onClose}
        >
          <X size={20} />
        </button>
      </header>
      <div className="project-manager-body">
        <form className="project-register-form" onSubmit={submit} aria-busy={mutation.isPending}>
          <label className="field">
            <span>{t("Title")}</span>
            <input
              ref={titleInputRef}
              required
              maxLength={400}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                mutation.reset();
              }}
              placeholder={t("Concrete, reviewable outcome")}
            />
          </label>
          <label className="field">
            <span>{t("Description")}</span>
            <textarea
              rows={5}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("Scope, constraints, and acceptance evidence")}
            />
          </label>
          <Select
            className="field"
            label={t("Initial state")}
            value={status}
            options={[
              { value: "READY", label: t("Ready to claim") },
              { value: "BACKLOG", label: t("Backlog") },
            ]}
            onChange={(value) => setStatus(value as typeof status)}
          />
          <Select
            className="field"
            label={t("Priority")}
            value={priority}
            options={[
              { value: "low", label: t("Low") },
              { value: "normal", label: t("Normal") },
              { value: "high", label: t("High") },
              { value: "critical", label: t("Critical") },
            ]}
            onChange={(value) => setPriority(value as Task["priority"])}
          />
          {mutation.error && (
            <span className="project-register-error" role="alert">
              {mutation.error.message}
            </span>
          )}
          <div className="heading-actions">
            <button className="text-button" type="button" onClick={onClose}>
              {t("Cancel")}
            </button>
            <button
              className="primary-button"
              type="submit"
              disabled={!title.trim() || mutation.isPending}
            >
              <Plus size={16} /> {mutation.isPending ? t("Creating…") : t("Create task")}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}

export function TasksPage({ overview }: { overview: Overview }) {
  const [view, setView] = useState<"board" | "graph">("board");
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const visibleTasks = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return overview.tasks;
    return overview.tasks.filter((task) =>
      `${task.title} ${task.description} ${task.id} ${task.status} ${task.ownerAgentId ?? ""} ${task.capabilityTags.join(" ")}`
        .toLowerCase()
        .includes(normalized),
    );
  }, [overview.tasks, query]);
  const graph = useMemo(() => {
    const visibleIds = new Set(visibleTasks.map((task) => task.id));
    const nodes: Node[] = visibleTasks.map((task, index) => ({
      id: task.id,
      position: { x: (index % 4) * 250, y: Math.floor(index / 4) * 130 },
      data: { label: task.title },
      className: `flow-node ${task.status.toLowerCase()}`,
    }));
    const edges: Edge[] = visibleTasks.flatMap((task) =>
      task.dependsOn
        .filter((dependency) => visibleIds.has(dependency))
        .map((dependency) => ({
          id: `${dependency}-${task.id}`,
          source: dependency,
          target: task.id,
          animated: task.status === "BLOCKED",
        })),
    );
    return { nodes, edges };
  }, [visibleTasks]);
  return (
    <div className="standard-page">
      <div className="page-heading">
        <div>
          <span className="eyebrow">{t("Work orchestration")}</span>
          <h1>{t("Task board")}</h1>
          <p>{t("Atomic ownership, evidence-weighted progress, and explicit review gates.")}</p>
        </div>
        <div className="heading-actions">
          <label className="inline-search">
            <MagnifyingGlass size={16} aria-hidden="true" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("Filter tasks")}
              placeholder={t("Filter tasks")}
            />
          </label>
          <div className="segmented" role="group" aria-label={t("Task visualization")}>
            <button
              type="button"
              className={view === "board" ? "active" : ""}
              aria-pressed={view === "board"}
              onClick={() => setView("board")}
            >
              {t("Board")}
            </button>
            <button
              type="button"
              className={view === "graph" ? "active" : ""}
              aria-pressed={view === "graph"}
              onClick={() => setView("graph")}
            >
              {t("Dependencies")}
            </button>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={!overview.objective}
            title={
              overview.objective
                ? t("Create a task in the active objective")
                : t("Create an active objective before adding tasks")
            }
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={16} /> {t("New task")}
          </button>
        </div>
      </div>
      {visibleTasks.length === 0 ? (
        <Panel>
          <EmptyState
            title={overview.tasks.length ? t("No matching tasks") : t("No tasks yet")}
            text={
              overview.tasks.length
                ? t("Adjust the filter to return to the full task board.")
                : overview.objective
                  ? t("Create the first task for the active objective.")
                  : t("Create an active objective before adding work.")
            }
          />
        </Panel>
      ) : view === "board" ? (
        <div className="kanban">
          {COLUMNS.map((entry) => {
            const tasks = visibleTasks.filter((task) => column(task) === entry.key);
            return (
              <section key={entry.key} className="kanban-column">
                <header>
                  <span>{entry.label}</span>
                  <b>{tasks.length}</b>
                </header>
                <div>
                  {tasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                  {tasks.length === 0 && (
                    <div className="kanban-empty">{t("No tasks in this state")}</div>
                  )}
                </div>
              </section>
            );
          })}
        </div>
      ) : (
        <Panel className="dependency-panel">
          {visibleTasks.length ? (
            <ReactFlow nodes={graph.nodes} edges={graph.edges} fitView minZoom={0.35}>
              <Background color="#24313a" gap={24} />
              <Controls />
            </ReactFlow>
          ) : (
            <EmptyState
              title={t("No dependency graph")}
              text={t("Create tasks to populate the objective graph.")}
            />
          )}
        </Panel>
      )}
      <TaskInspector projectId={overview.project.id} />
      <CreateTaskDialog
        open={createOpen}
        overview={overview}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}
