import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import ts from "typescript";

const repositoryRoot = resolve(import.meta.dirname, "..");

function gitFiles(arguments_) {
  return execFileSync("git", arguments_, {
    cwd: repositoryRoot,
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"))
    .filter((file) => {
      const absolute = resolve(repositoryRoot, file);
      return existsSync(absolute) && statSync(absolute).isFile();
    });
}

const trackedFiles = gitFiles(["ls-files", "-z", "--cached"]);
const repositoryFiles = gitFiles(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
const problems = [];
const generatedSegments = new Set([
  ".playwright-cli",
  ".vite",
  "coverage",
  "dist",
  "node_modules",
  "output",
  "playwright-report",
  "test-results",
]);
const generatedExtensions = /\.(?:bak|db|db-shm|db-wal|log|old|sqlite|sqlite3|tmp|tsbuildinfo)$/i;
const codeExtensions = new Set([".cjs", ".js", ".jsx", ".mjs", ".ts", ".tsx"]);

for (const file of trackedFiles) {
  const segments = file.split("/");
  if (
    segments.some((segment) => generatedSegments.has(segment)) ||
    generatedExtensions.test(file)
  ) {
    problems.push(`tracked generated/runtime artifact: ${file}`);
  }
}

for (const file of repositoryFiles) {
  if (/^bugreport.*\.md$/i.test(file)) {
    problems.push(`root incident report must live under docs/incidents/: ${file}`);
  }
}

for (const sample of [
  ".playwright-cli/probe.log",
  "coverage/probe.json",
  "output/probe.db",
  "playwright-report/index.html",
  "test-results/probe.json",
]) {
  const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", sample], {
    cwd: repositoryRoot,
  });
  if (ignored.status !== 0) problems.push(`disposable artifact is not ignored: ${sample}`);
}

function packageName(specifier) {
  if (specifier.startsWith("@")) return specifier.split("/").slice(0, 2).join("/");
  return specifier.split("/")[0];
}

function importsIn(file) {
  const source = readFileSync(resolve(repositoryRoot, file), "utf8");
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith(".tsx") || file.endsWith(".jsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports = new Set();

  function visit(node) {
    let specifier;
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      specifier = node.moduleSpecifier.text;
    } else if (
      ts.isCallExpression(node) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0]) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifier = node.arguments[0].text;
    }
    if (specifier && !specifier.startsWith(".") && !specifier.startsWith("node:")) {
      imports.add(packageName(specifier));
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports;
}

const importsByFile = new Map(
  repositoryFiles
    .filter((file) => codeExtensions.has(extname(file).toLowerCase()))
    .map((file) => [file, importsIn(file)]),
);
const manifestFiles = repositoryFiles.filter(
  (file) => file === "package.json" || /^(?:apps|packages)\/[^/]+\/package\.json$/.test(file),
);
let declaredRuntimeDependencies = 0;

for (const manifestFile of manifestFiles) {
  const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, manifestFile), "utf8"));
  const packageDirectory = dirname(manifestFile).replaceAll("\\", "/");
  const packagePrefix = packageDirectory === "." ? "" : `${packageDirectory}/`;
  const importedPackages = new Set();

  for (const [file, imports] of importsByFile) {
    if (file.startsWith(packagePrefix) && !file.includes("/dist/")) {
      for (const imported of imports) importedPackages.add(imported);
    }
  }

  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    declaredRuntimeDependencies += 1;
    if (!importedPackages.has(dependency)) {
      problems.push(`unused direct dependency in ${manifestFile}: ${dependency}`);
    }
  }

  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    if (
      /process\.exit\s*\(\s*0\s*\)/.test(command) ||
      /(?:^|[;&|]\s*)exit\s+0(?:\s|$)/i.test(command) ||
      /^(?:true|true\.exe)$/i.test(command.trim())
    ) {
      problems.push(`no-op script in ${manifestFile}: ${name} -> ${command}`);
    }
  }

  if (
    manifestFile.startsWith("packages/") &&
    manifest.name &&
    !manifest.bin &&
    !repositoryFiles.some(
      (file) =>
        !file.startsWith(packagePrefix) && importsByFile.get(file)?.has(String(manifest.name)),
    )
  ) {
    problems.push(`unconsumed workspace library: ${manifest.name} (${manifestFile})`);
  }
}

// The work log is local process, not part of the repository, so a clone will not have one and its
// absence is the normal case rather than a fault. The cap still applies where one exists, because
// an unbounded log is what it was written to prevent.
const workLogPath = resolve(repositoryRoot, "agents_task.md");
const workLogEntries = existsSync(workLogPath)
  ? readFileSync(workLogPath, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.startsWith("- ")).length
  : 0;
if (workLogEntries > 50) {
  problems.push(`agents_task.md has ${workLogEntries} entries; maximum is 50`);
}

// docs/protocol.md documented `GET /ws?token=<bearer>` long after the server started refusing a
// credential in the URL. A reader following it gets a 403, and the habit it teaches -- pasting a
// token into a URL, where proxies, history and referrers keep it -- is the real cost. Documentation
// drifts silently, so the shape is refused here rather than left to review.
const credentialInUrl = /[?&](?:token|bearer|access_token)=/;
for (const file of trackedFiles.filter((name) => name.endsWith(".md"))) {
  const lines = readFileSync(resolve(repositoryRoot, file), "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (credentialInUrl.test(line)) {
      problems.push(`${file}:${index + 1} documents a credential in a URL: ${line.trim()}`);
    }
  }
}

if (problems.length > 0) {
  console.error("Repository hygiene failed:");
  for (const problem of problems) console.error(`- ${problem}`);
  process.exitCode = 1;
} else {
  console.log(
    `Repository hygiene passed: ${trackedFiles.length} tracked files, ${manifestFiles.length - 1} workspaces, ${declaredRuntimeDependencies} referenced runtime dependencies, ${workLogEntries}/50 work-log entries.`,
  );
}
