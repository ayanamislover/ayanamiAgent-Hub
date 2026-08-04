import { lstatSync, readdirSync, rmSync, statSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const apply = process.argv.includes("--apply");
const supportedArguments = new Set(["--", "--apply"]);
const unknownArguments = process.argv
  .slice(2)
  .filter((argument) => !supportedArguments.has(argument));

if (unknownArguments.length > 0) {
  throw new Error(`Unknown clean-artifacts argument(s): ${unknownArguments.join(", ")}`);
}

const disposableDirectoryNames = [
  ".playwright-cli",
  ".vite",
  "coverage",
  "output",
  "playwright-report",
  "test-results",
];

function workspaceDirectories(group) {
  const parent = resolve(repositoryRoot, group);
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(parent, entry.name));
}

function assertInsideRepository(target) {
  const normalizedRoot = `${repositoryRoot}${sep}`.toLowerCase();
  const normalizedTarget = target.toLowerCase();
  if (
    normalizedTarget === repositoryRoot.toLowerCase() ||
    !normalizedTarget.startsWith(normalizedRoot)
  ) {
    throw new Error(`Refusing artifact target outside repository: ${target}`);
  }
}

function measure(target) {
  const entry = lstatSync(target);
  if (entry.isSymbolicLink()) {
    throw new Error(`Refusing symbolic-link artifact target: ${target}`);
  }
  if (!entry.isDirectory()) return { files: 1, bytes: entry.size };

  let files = 0;
  let bytes = 0;
  for (const child of readdirSync(target, { withFileTypes: true })) {
    const childPath = resolve(target, child.name);
    const measured = measure(childPath);
    files += measured.files;
    bytes += measured.bytes;
  }
  return { files, bytes };
}

const searchRoots = [
  repositoryRoot,
  ...workspaceDirectories("apps"),
  ...workspaceDirectories("packages"),
];
const targets = [];

for (const searchRoot of searchRoots) {
  for (const directoryName of disposableDirectoryNames) {
    const target = resolve(searchRoot, directoryName);
    assertInsideRepository(target);
    try {
      if (statSync(target).isDirectory()) {
        targets.push({ target, ...measure(target) });
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

const totals = targets.reduce(
  (summary, target) => ({
    files: summary.files + target.files,
    bytes: summary.bytes + target.bytes,
  }),
  { files: 0, bytes: 0 },
);

for (const target of targets) {
  const label = relative(repositoryRoot, target.target).replaceAll("\\", "/");
  console.log(
    `${apply ? "delete" : "would delete"} ${label} (${target.files} files, ${(target.bytes / 1024 / 1024).toFixed(2)} MiB)`,
  );
  if (apply) rmSync(target.target, { recursive: true, force: false });
}

console.log(
  `${apply ? "deleted" : "dry run"}: ${targets.length} directories, ${totals.files} files, ${(totals.bytes / 1024 / 1024).toFixed(2)} MiB`,
);
