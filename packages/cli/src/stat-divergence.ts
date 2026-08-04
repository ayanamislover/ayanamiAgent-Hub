import type { Stats } from "node:fs";

/**
 * The file-identity fields that must not move between opening a file and finishing the read.
 *
 * `mtimeMs` is not always wanted: the worker proof sidecar deliberately compares identity only, so
 * callers pass the subset they mean.
 */
const IDENTITY_FIELDS = ["dev", "ino", "size", "mtimeMs"] as const;

type IdentityField = (typeof IDENTITY_FIELDS)[number];

/**
 * What changed about a file between the handle it was read through and the path it was read from.
 *
 * Returns one entry per divergence, empty when the file is unchanged. Callers refuse the read when
 * it is non-empty and put the entries in the error, so the decision and the explanation come from
 * one place -- a guard whose message is computed separately from its condition can report a field
 * the condition did not actually trip on.
 *
 * `dev` is skipped when either side reports 0, which means "not reported" rather than "a different
 * volume". libuv fills the volume serial number from an open handle but not always from a path, so
 * on a GitHub Windows runner `fstat` returns a real serial and `lstat` returns 0 for the same file;
 * the guards read that as a swap and refused every managed Bridge runtime state read there. It is
 * not a CI artifact -- any volume whose path stat omits the serial fails the same way for a real
 * user.
 *
 * Skipping it costs nothing the remaining checks do not already provide. A file replaced underneath
 * the reader still moves `ino`, and a file cannot be swapped onto a different volume while its path
 * stays the same unless that path becomes a mount point or a link, which the reparse and
 * symbolic-link checks below reject separately.
 */
export function statIdentityDivergence(
  opened: Stats,
  observed: Stats,
  fields: readonly IdentityField[] = IDENTITY_FIELDS,
): string[] {
  const changed: string[] = [];
  if (observed.isSymbolicLink()) changed.push("became a symbolic link");
  if (!observed.isFile()) changed.push("stopped being a regular file");
  for (const field of fields) {
    if (field === "dev" && (opened.dev === 0 || observed.dev === 0)) continue;
    if (observed[field] !== opened[field]) {
      changed.push(`${field} ${String(opened[field])} -> ${String(observed[field])}`);
    }
  }
  return changed;
}
