import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createReviewPatch } from "../src/git/git-service.js";

/**
 * An immutable review snapshot is supposed to show the reviewer the task's work and nothing else.
 * With includeUncommitted it showed the whole working tree instead: the uncommitted diff, the
 * observed change list and the untracked sweep were all unfiltered, so a task scoped to one
 * directory produced a patch containing every dirty file in the repository. Two reviews requested
 * minutes apart could end up with the same patchSha256 because the working tree, not the task,
 * dominated the content.
 *
 * The committed base..head range is deliberately NOT filtered. That range is the frozen snapshot the
 * author chose, and a reviewer verifies it by recomputing `git diff --binary --full-index base head`;
 * filtering it would make the published patch impossible to reproduce with the documented command.
 */
describe("review patch scope", () => {
  let root: string;
  let base: string;
  let head: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  const write = (path: string, body: string) => {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), body);
  };

  beforeEach(() => {
    root = mkdtempSync(resolve(tmpdir(), "review-scope-"));
    git("init", "-q");
    git("config", "user.email", "test@local");
    git("config", "user.name", "test");
    write("apps/hub/in-scope.ts", "export const a = 1;\n");
    write("apps/dashboard/out-of-scope.ts", "export const b = 1;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
    base = git("rev-parse", "HEAD");

    // One committed change on each side, so the base..head range covers both directories.
    write("apps/hub/in-scope.ts", "export const a = 2;\n");
    write("apps/dashboard/out-of-scope.ts", "export const b = 2;\n");
    git("add", "-A");
    git("commit", "-q", "-m", "head");
    head = git("rev-parse", "HEAD");

    // Now dirty the tree on both sides: a tracked edit and an untracked file in each directory.
    write("apps/hub/in-scope.ts", "export const a = 3;\n");
    write("apps/dashboard/out-of-scope.ts", "export const b = 3;\n");
    write("apps/hub/new-in-scope.ts", "export const c = 1;\n");
    write("apps/dashboard/new-out-of-scope.ts", "export const d = 1;\n");
  });

  it("keeps uncommitted work outside the task scope out of the patch", () => {
    const { patch, changedFiles } = createReviewPatch(root, base, head, true, ["apps/hub/**"]);
    const paths = changedFiles.map((file) => file.path);

    expect(paths).toContain("apps/hub/in-scope.ts");
    expect(paths).toContain("apps/hub/new-in-scope.ts");
    // The tracked out-of-scope file is legitimately in base..head, so it stays; what must not
    // appear is its uncommitted content or the untracked file beside it.
    expect(paths).not.toContain("apps/dashboard/new-out-of-scope.ts");
    expect(patch).not.toContain("export const d = 1;");
    expect(patch).not.toContain("export const b = 3;");
    // The in-scope uncommitted content is the whole point of includeUncommitted.
    expect(patch).toContain("export const a = 3;");
    expect(patch).toContain("export const c = 1;");
  });

  it("still reproduces the committed range exactly, so the published hash can be recomputed", () => {
    const { patch } = createReviewPatch(root, base, head, false, ["apps/hub/**"]);
    const reference = execFileSync("git", ["diff", "--binary", "--full-index", base, head], {
      cwd: root,
      encoding: "utf8",
    });

    // Byte-identical to the documented command, scope argument notwithstanding.
    expect(patch).toBe(reference);
    expect(patch).toContain("export const b = 2;");
  });

  it("falls back to the whole working tree when no scope is given", () => {
    const { changedFiles } = createReviewPatch(root, base, head, true);
    const paths = changedFiles.map((file) => file.path);

    expect(paths).toContain("apps/hub/new-in-scope.ts");
    expect(paths).toContain("apps/dashboard/new-out-of-scope.ts");
  });

  it("treats an empty scope list as unscoped rather than as matching nothing", () => {
    const { changedFiles } = createReviewPatch(root, base, head, true, []);

    expect(changedFiles.map((file) => file.path)).toContain("apps/dashboard/new-out-of-scope.ts");
  });
});
