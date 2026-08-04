import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import type { HubClient } from "@crossagent/client";

function git(args: string[], cwd: string, input?: Buffer): void {
  const result = spawnSync("git", args, {
    cwd,
    input,
    encoding: input ? "buffer" : "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || `git ${args.join(" ")} failed`));
  }
}

function basePath(projectId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) throw new Error("Invalid project id");
  return resolve(homedir(), ".crossagent", "review-worktrees", projectId);
}

function assertReviewId(reviewId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(reviewId)) throw new Error("Invalid review id");
}

export async function checkoutReview(
  client: HubClient,
  reviewId: string,
  projectRoot: string,
): Promise<string> {
  assertReviewId(reviewId);
  const review = await client.request<{
    id: string;
    projectId: string;
    headSha: string;
    patchArtifactId: string;
  }>("GET", `/api/reviews/${encodeURIComponent(reviewId)}`);
  const root = basePath(review.projectId);
  const worktree = resolve(root, review.id);
  if (existsSync(worktree)) throw new Error(`Review worktree already exists: ${worktree}`);
  mkdirSync(dirname(worktree), { recursive: true });
  git(["worktree", "add", "--detach", worktree, review.headSha], projectRoot);
  try {
    const response = await fetch(
      `${client.baseUrl}/api/artifacts/${encodeURIComponent(review.patchArtifactId)}/content`,
      { headers: { authorization: `Bearer ${client.token}` } },
    );
    if (!response.ok) throw new Error(`Unable to download review patch: HTTP ${response.status}`);
    const patch = Buffer.from(await response.arrayBuffer());
    const patchPath = resolve(root, `${review.id}.patch`);
    writeFileSync(patchPath, patch);
    if (patch.length > 0) git(["apply", "--whitespace=nowarn", "-"], worktree, patch);
    return worktree;
  } catch (error) {
    try {
      git(["worktree", "remove", "--force", worktree], projectRoot);
      git(["worktree", "prune"], projectRoot);
    } catch {
      if (existsSync(worktree)) rmSync(worktree, { recursive: true });
    }
    throw error;
  }
}

export function cleanupReview(reviewId: string, projectId: string, projectRoot: string): string {
  assertReviewId(reviewId);
  const root = basePath(projectId);
  const worktree = resolve(root, reviewId);
  if (!worktree.startsWith(`${root}\\`) && !worktree.startsWith(`${root}/`)) {
    throw new Error("Resolved worktree escaped the review worktree root");
  }
  git(["worktree", "remove", "--force", worktree], projectRoot);
  git(["worktree", "prune"], projectRoot);
  return worktree;
}
