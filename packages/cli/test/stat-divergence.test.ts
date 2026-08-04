import type { Stats } from "node:fs";
import { describe, expect, it } from "vitest";
import { statIdentityDivergence } from "../src/stat-divergence.js";

function stats(
  overrides: Partial<Stats> & { symbolicLink?: boolean; regularFile?: boolean },
): Stats {
  const { symbolicLink = false, regularFile = true, ...fields } = overrides;
  return {
    dev: 450_199_448,
    ino: 844_424_934_964_088,
    size: 128,
    mtimeMs: 1_764_000_000_000,
    ...fields,
    isSymbolicLink: () => symbolicLink,
    isFile: () => regularFile,
  } as unknown as Stats;
}

describe("stat identity divergence", () => {
  it("reports nothing when the file did not move", () => {
    expect(statIdentityDivergence(stats({}), stats({}))).toEqual([]);
  });

  it("treats an unreported dev as unknown rather than as a different volume", () => {
    // libuv fills the volume serial from an open handle but not always from a path, so fstat can
    // report a serial where lstat reports 0 for the same file. Reading that as a swap refused every
    // managed Bridge runtime state read on a GitHub Windows runner.
    expect(statIdentityDivergence(stats({}), stats({ dev: 0 }))).toEqual([]);
    expect(statIdentityDivergence(stats({ dev: 0 }), stats({}))).toEqual([]);
  });

  it("still reports a genuinely different volume when both sides report one", () => {
    expect(statIdentityDivergence(stats({}), stats({ dev: 42 }))).toEqual(["dev 450199448 -> 42"]);
  });

  it("still catches a swapped file when dev is unreported", () => {
    // The point of dropping dev: the swap detection must survive it. An inode that moves is the
    // check that actually matters, and it has to fire on the exact platform where dev cannot.
    expect(statIdentityDivergence(stats({ dev: 0 }), stats({ dev: 0, ino: 999 }))).toEqual([
      "ino 844424934964088 -> 999",
    ]);
  });

  it("reports a truncated or rewritten file and a moved timestamp", () => {
    expect(statIdentityDivergence(stats({}), stats({ size: 0, mtimeMs: 1 }))).toEqual([
      "size 128 -> 0",
      "mtimeMs 1764000000000 -> 1",
    ]);
  });

  it("honours a caller that compares identity without the timestamp", () => {
    expect(
      statIdentityDivergence(stats({}), stats({ mtimeMs: 1 }), ["dev", "ino", "size"]),
    ).toEqual([]);
  });

  it("refuses a path that stopped being the regular file it was opened as", () => {
    expect(statIdentityDivergence(stats({}), stats({ symbolicLink: true }))).toEqual([
      "became a symbolic link",
    ]);
    expect(statIdentityDivergence(stats({}), stats({ regularFile: false }))).toEqual([
      "stopped being a regular file",
    ]);
  });
});
