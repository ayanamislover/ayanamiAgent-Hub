import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

/**
 * Fixture projects must live outside this repository's git tree.
 *
 * joinProject resolves a cwd to its git root and adopts that root's `.crossagent/project.json`, so
 * a fixture under `output/` did not create its own project at all: on a machine that had ever run
 * the review smoke it silently joined *this* repository and inherited its name, and on a clean
 * checkout it would instead write a project marker into the working tree.
 *
 * The temp directory is canonicalized because a GitHub Windows runner reports it in 8.3 short form,
 * which does not compare equal to the path the Hub stores.
 */
const fixtureRoot = resolve(realpathSync.native(tmpdir()), "crossagent-e2e-fixtures");

export function fixtureProject(name: string): string {
  const path = resolve(fixtureRoot, name);
  mkdirSync(path, { recursive: true });
  return path;
}

/** Drops the project markers a previous run left behind, so setup starts from nothing. */
export function resetFixtureProjects(): void {
  rmSync(fixtureRoot, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });
}

/** The second project the navigation case switches to. Global setup joins it before the primary. */
export const SECONDARY_PROJECT_NAME = "Navigation fixture";
