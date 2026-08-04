import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeProject } from "../src/project-init.js";

describe("initializeProject", () => {
  it("creates stable metadata and remains idempotent", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-project-"));
    const first = initializeProject(root);
    const second = initializeProject(root);
    expect(first.projectId).toBe(second.projectId);
    expect(first.created.length).toBeGreaterThan(0);
    expect(second.created).toEqual([]);
    expect(existsSync(resolve(root, ".crossagent", "config.json"))).toBe(true);
  });
});
