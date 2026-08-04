// ---------------------------------------------------------------------------------------
// Model presets
//
// Global rather than per-project: which models a CLI accepts is a property of the installed
// tool, not of the repository being worked on.
// ---------------------------------------------------------------------------------------

import { createId, nowIso, type ModelPreset } from "@crossagent/protocol";
import { NotFoundError } from "../../domain/errors.js";
import type { StoreContext } from "./context.js";

function modelPresetFromRow(row: any): ModelPreset {
  return {
    id: row.id,
    agentId: row.agent_id,
    modelId: row.model_id,
    label: row.label,
    reasoningEfforts: JSON.parse(row.reasoning_efforts_json ?? "[]"),
    launchArgs: JSON.parse(row.launch_args_json ?? "[]"),
    effortArgs: JSON.parse(row.effort_args_json ?? "[]"),
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function listModelPresets(ctx: StoreContext, agentId?: string): ModelPreset[] {
  const rows = ctx.sqlite
    .prepare(
      `SELECT * FROM model_presets
           WHERE (? IS NULL OR agent_id = ?)
           ORDER BY agent_id ASC, sort_order ASC, label ASC`,
    )
    .all(agentId ?? null, agentId ?? null) as Record<string, unknown>[];
  return rows.map(modelPresetFromRow);
}

export function upsertModelPreset(
  ctx: StoreContext,
  input: {
    agentId: string;
    modelId: string;
    label: string;
    reasoningEfforts: string[];
    launchArgs: string[];
    effortArgs: string[];
    enabled: boolean;
    sortOrder: number;
  },
): ModelPreset {
  const now = nowIso();
  const existing = ctx.sqlite
    .prepare("SELECT id FROM model_presets WHERE agent_id = ? AND model_id = ?")
    .get(input.agentId, input.modelId) as { id: string } | undefined;
  const id = existing?.id ?? createId("mdp");
  ctx.sqlite
    .prepare(
      `INSERT INTO model_presets(
           id, agent_id, model_id, label, reasoning_efforts_json, launch_args_json,
           effort_args_json, enabled, sort_order, version, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(agent_id, model_id) DO UPDATE SET
           label = excluded.label,
           reasoning_efforts_json = excluded.reasoning_efforts_json,
           launch_args_json = excluded.launch_args_json,
           effort_args_json = excluded.effort_args_json,
           enabled = excluded.enabled,
           sort_order = excluded.sort_order,
           version = model_presets.version + 1,
           updated_at = excluded.updated_at`,
    )
    .run(
      id,
      input.agentId,
      input.modelId,
      input.label,
      JSON.stringify(input.reasoningEfforts),
      JSON.stringify(input.launchArgs),
      JSON.stringify(input.effortArgs),
      input.enabled ? 1 : 0,
      input.sortOrder,
      now,
      now,
    );
  const row = ctx.sqlite
    .prepare("SELECT * FROM model_presets WHERE agent_id = ? AND model_id = ?")
    .get(input.agentId, input.modelId) as Record<string, unknown>;
  return modelPresetFromRow(row);
}

export function deleteModelPreset(ctx: StoreContext, id: string): void {
  const result = ctx.sqlite.prepare("DELETE FROM model_presets WHERE id = ?").run(id);
  if (result.changes === 0) throw new NotFoundError("Model preset", id);
}

/**
 * Turns a preset plus an optional effort into concrete argv. The effort flags are a separate
 * list rather than a filtered subset of the launch args: dropping `{effort}` tokens from one
 * template left the flag behind (`-m gpt-5.1-codex -c`), which the CLI refuses to start on.
 */
export function resolveLaunchArgs(preset: ModelPreset, effort?: string): string[] {
  const tokens = effort ? [...preset.launchArgs, ...preset.effortArgs] : preset.launchArgs;
  return tokens.map((token) =>
    token.replace("{model}", preset.modelId).replace("{effort}", effort ?? ""),
  );
}
