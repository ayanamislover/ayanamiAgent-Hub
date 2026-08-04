import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import picomatch from "picomatch";
import { ForbiddenError, HubError } from "../domain/errors.js";

function git(args: string[], cwd: string, allowFailure = false): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0 && !allowFailure) {
    throw new HubError(
      `git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`,
      422,
      "GIT_ERROR",
    );
  }
  return result.stdout;
}

export function canonicalPath(input: string): string {
  const absolute = resolve(input);
  return realpathSync.native(absolute);
}

export function findGitRoot(cwd: string): string | null {
  try {
    return canonicalPath(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }).trim(),
    );
  } catch {
    return null;
  }
}

export function readGitState(root: string): { branch: string | null; head: string | null } {
  try {
    const head = git(["rev-parse", "HEAD"], root).trim();
    const branch = git(["branch", "--show-current"], root, true).trim() || null;
    return { branch, head };
  } catch {
    return { branch: null, head: null };
  }
}

export function listTrackedFiles(root: string): string[] {
  return git(["ls-files", "-z"], root, true)
    .split("\0")
    .filter(Boolean)
    .map((value) => value.replaceAll("\\", "/"));
}

export function observedChangedFiles(root: string): string[] {
  const output = git(["status", "--porcelain=v1", "-z"], root, true);
  const entries = output.split("\0").filter(Boolean);
  const files = new Set<string>();
  for (const entry of entries) {
    const value = entry.slice(3);
    const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1)! : value;
    files.add(renamed.replaceAll("\\", "/"));
  }
  return [...files].sort();
}

export function ensureInsideRoot(root: string, candidate: string): string {
  const resolvedRoot = canonicalPath(root);
  const resolvedCandidate = existsSync(candidate) ? canonicalPath(candidate) : resolve(candidate);
  const rel = relative(resolvedRoot, resolvedCandidate);
  if (rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))) {
    return resolvedCandidate;
  }
  throw new ForbiddenError(`Path escapes registered project root: ${candidate}`);
}

export type IntentOverlap = {
  severity: "medium" | "high" | "critical";
  files: string[];
  symbols: string[];
  reason: string;
};

export function detectIntentOverlap(
  left: { globs: string[]; symbols: string[]; mode: string },
  right: { globs: string[]; symbols: string[]; mode: string },
  trackedFiles: string[],
  protectedGlobs: string[],
): IntentOverlap | null {
  const leftMatches = trackedFiles.filter((file) =>
    left.globs.some((glob) => picomatch.isMatch(file, glob, { dot: true })),
  );
  const rightSet = new Set(
    trackedFiles.filter((file) =>
      right.globs.some((glob) => picomatch.isMatch(file, glob, { dot: true })),
    ),
  );
  const exactFiles = leftMatches.filter((file) => rightSet.has(file));
  const symbols = left.symbols.filter((symbol) => right.symbols.includes(symbol));
  const leftDirs = new Set(leftMatches.map((file) => file.split("/", 1)[0]));
  const sharedDirectories = [...new Set([...rightSet].map((file) => file.split("/", 1)[0]))].filter(
    (directory) => leftDirs.has(directory),
  );
  if (exactFiles.length === 0 && symbols.length === 0 && sharedDirectories.length === 0) {
    return null;
  }
  const protectedFiles = exactFiles.filter((file) =>
    protectedGlobs.some((glob) => picomatch.isMatch(file, glob, { dot: true })),
  );
  // Two exclusive intents are only in critical conflict over something they actually contest. This
  // condition used to test the modes alone, and because the early return above only fires when the
  // files, symbols AND directories are all empty, "we both have work somewhere under apps/" was
  // enough to reach it -- so in a monorepo almost every pair of exclusive intents was reported
  // critical, with an empty file list to show for it. A shared top-level directory now falls through
  // to the medium branch, which is what it was always for. protectedFiles is drawn from exactFiles,
  // so the protected case is already guarded by construction.
  const contested = exactFiles.length > 0 || symbols.length > 0;
  if (
    protectedFiles.length > 0 ||
    (contested && left.mode === "exclusive" && right.mode === "exclusive")
  ) {
    return {
      severity: "critical",
      files: exactFiles,
      symbols,
      reason:
        protectedFiles.length > 0
          ? `Protected scope overlaps: ${protectedFiles.join(", ")}`
          : "Two exclusive write intents overlap",
    };
  }
  if (exactFiles.length > 0 || symbols.length > 0) {
    return {
      severity: "high",
      files: exactFiles,
      symbols,
      reason: exactFiles.length > 0 ? "Exact file overlap" : "Symbol overlap",
    };
  }
  return {
    severity: "medium",
    files: sharedDirectories.map((directory) => `${directory}/**`),
    symbols: [],
    reason: "Both intents touch the same top-level directory",
  };
}

/**
 * Builds the immutable patch a review is frozen against.
 *
 * `scopeGlobs` bounds the uncommitted portion only. Without it, includeUncommitted swept the entire
 * working tree into the snapshot, so a task scoped to one directory published a patch containing
 * every dirty file in the repository -- which is how two reviews requested minutes apart could share
 * one patchSha256: the tree, not the task, decided the content.
 *
 * The committed `base..head` range is deliberately left unfiltered. That range is the frozen snapshot
 * the author chose, and a reviewer verifies it by recomputing
 * `git diff --binary --full-index base head`; filtering it would make the published patch impossible
 * to reproduce with the documented command.
 */
export function createReviewPatch(
  root: string,
  baseSha: string,
  headSha: string,
  includeUncommitted: boolean,
  scopeGlobs?: string[],
): { patch: string; changedFiles: Array<{ path: string; status: string }> } {
  let patch = git(["diff", "--binary", "--full-index", baseSha, headSha], root);
  const nameStatus = git(["diff", "--name-status", baseSha, headSha], root, true);
  const changed = new Map<string, string>();
  for (const line of nameStatus.split(/\r?\n/).filter(Boolean)) {
    const [status = "M", ...parts] = line.split("\t");
    const path = parts.at(-1);
    if (path) changed.set(path.replaceAll("\\", "/"), status);
  }
  if (includeUncommitted) {
    // An absent or empty scope means unscoped, not "matches nothing": a task that declares no scope
    // must keep the previous whole-tree behaviour rather than silently freezing an empty patch.
    const inScope = scopeGlobs?.length
      ? (file: string) => scopeGlobs.some((glob) => picomatch.isMatch(file, glob, { dot: true }))
      : () => true;
    const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"], root, true)
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replaceAll("\\", "/"))
      .filter(inScope);
    const untrackedSet = new Set(untracked);
    // observedChangedFiles reports untracked entries too, and a `git diff <sha> -- <path>` for a path
    // git has never seen contributes nothing, so the two lists are separated rather than overlapped.
    const dirty = observedChangedFiles(root).filter(inScope);
    const trackedDirty = dirty.filter((file) => !untrackedSet.has(file));
    // Passing no paths after `--` diffs the whole tree, which would turn filtering into its own
    // opposite. When nothing tracked is in scope the call has to be skipped entirely.
    if (trackedDirty.length > 0) {
      patch += git(
        ["diff", "--binary", "--full-index", headSha, "--", ...trackedDirty],
        root,
        true,
      );
    }
    for (const file of dirty) changed.set(file, changed.get(file) ?? "W");
    for (const file of untracked) {
      const result = spawnSync("git", ["diff", "--no-index", "--binary", "--", "/dev/null", file], {
        cwd: root,
        encoding: "utf8",
        windowsHide: true,
      });
      if (result.stdout) patch += result.stdout;
      changed.set(file, "A");
    }
  }
  return {
    patch,
    changedFiles: [...changed.entries()]
      .map(([path, status]) => ({ path, status }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
}

export function saveArtifact(
  dataDir: string,
  projectId: string,
  artifactId: string,
  name: string,
  content: string | Buffer,
): { storagePath: string; sha256: string; sizeBytes: number } {
  const safeName = name.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  const storagePath = resolve(dataDir, "artifacts", projectId, artifactId, safeName);
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, content);
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content);
  return {
    storagePath,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    sizeBytes: buffer.length,
  };
}

export function readArtifact(path: string, maxBytes = 10 * 1024 * 1024): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > maxBytes) {
    throw new HubError("Artifact is not a readable bounded file", 422, "ARTIFACT_LIMIT");
  }
  return readFileSync(path);
}

export function checkoutReviewWorktree(
  projectRoot: string,
  worktreePath: string,
  headSha: string,
  patchPath: string,
): void {
  ensureInsideRoot(dirname(worktreePath), worktreePath);
  mkdirSync(dirname(worktreePath), { recursive: true });
  git(["worktree", "add", "--detach", worktreePath, headSha], projectRoot);
  const patch = readFileSync(patchPath);
  if (patch.length > 0) {
    const result = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
      cwd: worktreePath,
      input: patch,
      encoding: "buffer",
      windowsHide: true,
    });
    if (result.status !== 0) {
      git(["worktree", "remove", "--force", worktreePath], projectRoot, true);
      throw new HubError(
        `Unable to apply immutable review patch: ${String(result.stderr)}`,
        422,
        "PATCH_APPLY_FAILED",
      );
    }
  }
}

export function cleanupReviewWorktree(projectRoot: string, worktreePath: string): void {
  git(["worktree", "remove", "--force", worktreePath], projectRoot);
  git(["worktree", "prune"], projectRoot, true);
}
