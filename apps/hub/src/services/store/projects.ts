import {
  DEFAULT_PROJECT_CONFIG,
  ProjectConfigSchema,
  createId,
  nowIso,
  type Project,
} from "@crossagent/protocol";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { canonicalPath, findGitRoot, readGitState } from "../../git/git-service.js";
import { ConflictError, HubError, NotFoundError } from "../../domain/errors.js";
import type { RequestPrincipal } from "../../security/local-auth.js";
import { json, type StoreContext } from "./context.js";
import {
  assertDashboardMutation,
  mutationOptions,
  resolveProjectJoinActor,
  resolveMutationActor,
} from "./mutation-authority.js";

function projectFromRow(row: any): Project {
  return {
    id: row.id,
    name: row.name,
    defaultBranch: row.default_branch,
    activeObjectiveId: row.active_objective_id,
    config: json(row.config_json, {}),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getProject(ctx: StoreContext, projectId: string): Project {
  const row = ctx.sqlite.prepare("SELECT * FROM projects WHERE id = ?").get(projectId);
  if (!row) throw new NotFoundError("Project", projectId);
  return projectFromRow(row);
}

export function listProjects(ctx: StoreContext): Array<Project & { paths: string[] }> {
  return ctx.sqlite
    .prepare("SELECT * FROM projects ORDER BY updated_at DESC")
    .all()
    .map((row: any) => ({
      ...projectFromRow(row),
      paths: (
        ctx.sqlite
          .prepare(
            "SELECT canonical_path FROM project_paths WHERE project_id = ? ORDER BY is_primary DESC",
          )
          .all(row.id) as Array<{ canonical_path: string }>
      ).map((path) => path.canonical_path),
    }));
}

export function getProjectRegistration(
  ctx: StoreContext,
  projectId: string,
): {
  project: Project;
  root: string;
  paths: string[];
} {
  const project = getProject(ctx, projectId);
  const paths = (
    ctx.sqlite
      .prepare(
        `SELECT canonical_path FROM project_paths
           WHERE project_id = ? ORDER BY is_primary DESC, last_seen_at DESC`,
      )
      .all(projectId) as Array<{ canonical_path: string }>
  ).map((entry) => entry.canonical_path);
  if (!paths[0]) {
    throw new HubError(
      `Project ${projectId} has no registered local path`,
      409,
      "PROJECT_PATH_MISSING",
    );
  }
  return { project, root: paths[0], paths };
}

export function joinProject(
  ctx: StoreContext,
  principal: RequestPrincipal,
  input: { cwd: string; name?: string; allowCreate: boolean },
): {
  project: Project;
  root: string;
  created: boolean;
} {
  const candidate = resolve(input.cwd);
  if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
    throw new HubError(
      `Project directory does not exist: ${candidate}`,
      422,
      "PROJECT_PATH_INVALID",
    );
  }
  const requested = canonicalPath(input.cwd);
  const root = findGitRoot(requested) ?? requested;
  const metadataPath = resolve(root, ".crossagent", "project.json");
  let metadata: {
    schema_version: number;
    project_id: string;
    name: string;
    default_branch: string | null;
  };
  let created = false;
  if (existsSync(metadataPath)) {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
    if (metadata.schema_version !== 1 || !metadata.project_id) {
      throw new HubError("Unsupported .crossagent/project.json", 422, "PROJECT_SCHEMA");
    }
  } else {
    if (!input.allowCreate) {
      throw new HubError(
        "Project metadata is missing; rerun with allowCreate=true",
        409,
        "PROJECT_INIT_REQUIRED",
      );
    }
    assertDashboardMutation(principal);
    const gitState = readGitState(root);
    metadata = {
      schema_version: 1,
      project_id: createId("prj"),
      name: input.name ?? basename(root),
      default_branch: gitState.branch,
    };
    mkdirSync(dirname(metadataPath), { recursive: true });
    writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
    created = true;
  }
  const configPath = resolve(root, ".crossagent", "config.json");
  const configInput = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const config = ProjectConfigSchema.parse({
    ...DEFAULT_PROJECT_CONFIG,
    ...configInput,
    schemaVersion: 1,
  });
  const now = nowIso();
  const gitState = readGitState(root);
  const actor = resolveProjectJoinActor(ctx, principal, metadata.project_id);
  const event = ctx.sqlite.transaction(() => {
    ctx.sqlite
      .prepare(
        `INSERT INTO projects(
            id, name, default_branch, config_json, current_sequence, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 0, 0, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            default_branch = COALESCE(excluded.default_branch, projects.default_branch),
            config_json = excluded.config_json,
            updated_at = excluded.updated_at`,
      )
      .run(
        metadata.project_id,
        metadata.name,
        metadata.default_branch,
        JSON.stringify(config),
        now,
        now,
      );
    const pathCount = ctx.sqlite
      .prepare("SELECT COUNT(*) AS count FROM project_paths WHERE project_id = ?")
      .get(metadata.project_id) as { count: number };
    ctx.sqlite
      .prepare(
        `INSERT INTO project_paths(
            id, project_id, canonical_path, worktree_branch, git_head, is_primary, last_seen_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(project_id, canonical_path) DO UPDATE SET
            worktree_branch = excluded.worktree_branch,
            git_head = excluded.git_head,
            last_seen_at = excluded.last_seen_at`,
      )
      .run(
        createId("pth"),
        metadata.project_id,
        root,
        gitState.branch,
        gitState.head,
        pathCount.count === 0 ? 1 : 0,
        now,
      );
    return ctx.appendEvent({
      projectId: metadata.project_id,
      type: created ? "project.created" : "project.joined",
      actorType: actor.actorType,
      actorId: actor.actorId,
      aggregateType: "project",
      aggregateId: metadata.project_id,
      causationId: null,
      correlationId: null,
      payload: { root, created, gitState },
    });
  })();
  ctx.bus.publish(event);
  return { project: getProject(ctx, metadata.project_id), root, created };
}

export function createObjective(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: {
    title: string;
    description: string;
    definitionOfDone: string[];
    status: "PLANNED" | "ACTIVE";
    idempotencyKey: string;
  },
) {
  const actor = resolveMutationActor(ctx, principal, projectId);
  return ctx.mutate(
    projectId,
    input.idempotencyKey,
    "objective.create",
    ({ emit }) => {
      const id = createId("obj");
      const now = nowIso();
      if (input.status === "ACTIVE") {
        ctx.sqlite
          .prepare(
            "UPDATE objectives SET status = 'PLANNED', version = version + 1, updated_at = ? WHERE project_id = ? AND status = 'ACTIVE'",
          )
          .run(now, projectId);
      }
      ctx.sqlite
        .prepare(
          `INSERT INTO objectives(
            id, project_id, title, description, definition_of_done_json, status,
            weight, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(
          id,
          projectId,
          input.title,
          input.description,
          JSON.stringify(input.definitionOfDone),
          input.status,
          now,
          now,
        );
      if (input.status === "ACTIVE") {
        ctx.sqlite
          .prepare(
            "UPDATE projects SET active_objective_id = ?, version = version + 1, updated_at = ? WHERE id = ?",
          )
          .run(id, now, projectId);
      }
      emit({
        projectId,
        type: "objective.created",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "objective",
        aggregateId: id,
        causationId: null,
        correlationId: null,
        payload: { title: input.title, status: input.status },
      });
      return ctx.sqlite.prepare("SELECT * FROM objectives WHERE id = ?").get(id);
    },
    mutationOptions(actor, { projectId, ...input, idempotencyKey: undefined }),
  );
}

export function createMilestone(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: {
    objectiveId: string;
    title: string;
    description: string;
    sortOrder: number;
    weight: number;
    idempotencyKey: string;
  },
) {
  const actor = resolveMutationActor(ctx, principal, projectId);
  return ctx.mutate(
    projectId,
    input.idempotencyKey,
    "milestone.create",
    ({ emit }) => {
      const id = createId("mil");
      const now = nowIso();
      ctx.sqlite
        .prepare(
          `INSERT INTO milestones(
            id, project_id, objective_id, title, description, sort_order, weight,
            status, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PLANNED', 0, ?, ?)`,
        )
        .run(
          id,
          projectId,
          input.objectiveId,
          input.title,
          input.description,
          input.sortOrder,
          input.weight,
          now,
          now,
        );
      emit({
        projectId,
        type: "milestone.created",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "milestone",
        aggregateId: id,
        causationId: null,
        correlationId: null,
        payload: { objectiveId: input.objectiveId, title: input.title },
      });
      return ctx.sqlite.prepare("SELECT * FROM milestones WHERE id = ?").get(id);
    },
    mutationOptions(actor, { projectId, ...input, idempotencyKey: undefined }),
  );
}

export function updateProjectConfig(
  ctx: StoreContext,
  principal: RequestPrincipal,
  projectId: string,
  input: {
    expectedVersion: number;
    config: unknown;
    idempotencyKey: string;
  },
): Project {
  assertDashboardMutation(principal);
  const actor = resolveMutationActor(ctx, principal, projectId);
  return ctx.mutate(
    projectId,
    input.idempotencyKey,
    "project.config.update",
    ({ emit }) => {
      const current = getProject(ctx, projectId);
      if (current.version !== input.expectedVersion) {
        throw new ConflictError("Project version changed", current);
      }
      const config = ProjectConfigSchema.parse({
        ...DEFAULT_PROJECT_CONFIG,
        ...(input.config as object),
      });
      ctx.sqlite
        .prepare(
          `UPDATE projects SET config_json = ?, version = version + 1,
           updated_at = ? WHERE id = ?`,
        )
        .run(JSON.stringify(config), nowIso(), projectId);
      emit({
        projectId,
        type: "project.config.updated",
        actorType: actor.actorType,
        actorId: actor.actorId,
        aggregateType: "project",
        aggregateId: projectId,
        causationId: null,
        correlationId: null,
        payload: { config },
      });
      return getProject(ctx, projectId);
    },
    mutationOptions(actor, { projectId, ...input, idempotencyKey: undefined }),
  );
}
