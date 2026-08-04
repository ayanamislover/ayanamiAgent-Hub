import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createId } from "@crossagent/protocol";

function git(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

export function projectRoot(cwd: string): string {
  return resolve(git(["rev-parse", "--show-toplevel"], cwd) ?? cwd);
}

export const AGENT_RULES = `## CrossAgent collaboration

This project uses CrossAgent Hub.

At the start of work: join the project, get a Context Pack, inspect the action-required inbox, active objective, READY tasks, and peer state.
Before editing: atomically claim a task and declare a write intent. Public API, schema, configuration, dependency, lockfile, or migration changes require a proposal first.
Keep structured TODO evidence current. ACK action-required messages, reuse existing threads, avoid courtesy-only status traffic, and verify peer claims against code, Git, and tests.
Before completion: finish acceptance TODOs, run configured tests, request independent review, resolve blocking findings, publish a summary, and release write intents.
`;

export function initializeProject(cwd: string): {
  root: string;
  projectId: string;
  created: string[];
} {
  const root = projectRoot(cwd);
  const created: string[] = [];
  const projectDir = resolve(root, ".crossagent");
  mkdirSync(projectDir, { recursive: true });
  const projectPath = resolve(projectDir, "project.json");
  let projectId: string;
  if (existsSync(projectPath)) {
    const parsed = JSON.parse(readFileSync(projectPath, "utf8")) as {
      project_id: string;
    };
    projectId = parsed.project_id;
  } else {
    projectId = createId("prj");
    writeFileSync(
      projectPath,
      `${JSON.stringify(
        {
          schema_version: 1,
          project_id: projectId,
          name: basename(root),
          default_branch: git(["branch", "--show-current"], root) ?? null,
          project_secret_hint: randomBytes(4).toString("hex"),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    created.push(projectPath);
  }
  const configPath = resolve(projectDir, "config.json");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          protectedGlobs: ["package.json", "pnpm-lock.yaml", "migrations/**", "src/api/**"],
          wakePolicy: "urgent_and_action_required",
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    created.push(configPath);
  }
  for (const [name, content] of [
    ["AGENTS.fragment.md", AGENT_RULES],
    ["CLAUDE.fragment.md", AGENT_RULES],
  ] as const) {
    const path = resolve(projectDir, name);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${content.trim()}\n`, "utf8");
      created.push(path);
    }
  }
  return { root, projectId, created };
}
