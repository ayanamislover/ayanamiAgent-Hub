import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const BUILD_MANIFEST_RELATIVE_PATH = ".crossagent-build/release-manifest.json";
export const BUILD_LOCK_RELATIVE_PATH = ".crossagent-build/release.lock";
export const HUB_RUNTIME_LOCK_RELATIVE_PATH = ".crossagent-build/hub-runtime.lock";
export const HUB_SHUTDOWN_RECEIPT_NAME = "hub.shutdown.receipt.json";
export const BUILD_SIDECAR_NAME = ".crossagent-build.json";
export const BUILD_MANIFEST_SCHEMA_VERSION = 2;

export const RELEASE_COMPONENTS = Object.freeze([
  Object.freeze({
    name: "@crossagent/protocol",
    root: "packages/protocol",
    sidecar: `packages/protocol/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze([
      "packages/protocol/dist/index.js",
      "packages/protocol/dist/terminal.js",
    ]),
  }),
  Object.freeze({
    name: "@crossagent/client",
    root: "packages/client",
    sidecar: `packages/client/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze(["packages/client/dist/index.js"]),
  }),
  Object.freeze({
    name: "@crossagent/codex-bridge",
    root: "packages/codex-bridge",
    sidecar: `packages/codex-bridge/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze(["packages/codex-bridge/dist/index.js"]),
  }),
  Object.freeze({
    name: "@crossagent/hooks",
    root: "packages/hooks",
    sidecar: `packages/hooks/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze(["packages/hooks/dist/index.js", "packages/hooks/dist/hook.js"]),
  }),
  Object.freeze({
    name: "@crossagent/claude-channel",
    root: "packages/claude-channel",
    sidecar: `packages/claude-channel/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze([
      "packages/claude-channel/dist/index.js",
      "packages/claude-channel/dist/bin.js",
    ]),
  }),
  Object.freeze({
    name: "@crossagent/cli",
    root: "packages/cli",
    sidecar: `packages/cli/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze(["packages/cli/dist/index.js", "packages/cli/dist/bin.js"]),
  }),
  Object.freeze({
    name: "@crossagent/hub",
    root: "apps/hub",
    sidecar: `apps/hub/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze(["apps/hub/dist/index.js", "apps/hub/dist/main.js"]),
  }),
  Object.freeze({
    name: "@crossagent/dashboard",
    root: "apps/dashboard",
    sidecar: `apps/dashboard/dist/${BUILD_SIDECAR_NAME}`,
    entrypoints: Object.freeze(["apps/dashboard/dist/index.html"]),
  }),
]);

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Build identity cannot canonicalize undefined");
  return serialized;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys, label) {
  if (!isRecord(value)) throw new Error(`Invalid ${label}`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`Invalid ${label} fields`);
  }
}

function assertRelativePath(path, label) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    path.includes("\\") ||
    isAbsolute(path) ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Invalid ${label} path`);
  }
}

function safeWorkspaceFile(root, path, label) {
  assertRelativePath(path, label);
  const rootReal = realpathSync.native(root);
  const target = resolve(rootReal, ...path.split("/"));
  let targetReal;
  try {
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("not a regular file");
    targetReal = realpathSync.native(target);
  } catch {
    throw new Error(`Build ${label} is missing or not a regular file: ${path}`);
  }
  if (targetReal !== rootReal && !targetReal.startsWith(`${rootReal}${sep}`)) {
    throw new Error(`Build ${label} escapes the workspace: ${path}`);
  }
  return targetReal;
}

function readJsonFile(root, path, label) {
  const file = safeWorkspaceFile(root, path, label);
  const bytes = readFileSync(file);
  if (bytes.byteLength > 16 * 1024 * 1024) throw new Error(`Build ${label} is too large`);
  try {
    return { bytes, value: JSON.parse(bytes.toString("utf8")) };
  } catch {
    throw new Error(`Invalid JSON in build ${label}`);
  }
}

function normalizedWorkspaceRelative(root, path) {
  return relative(root, path).split(sep).join("/");
}

function listRegularFiles(root, directory, ignoredPaths = new Set()) {
  const absolute = resolve(root, directory);
  let entries;
  try {
    const directoryStat = lstatSync(absolute);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error("not a regular directory");
    }
    const rootReal = realpathSync.native(root);
    const directoryReal = realpathSync.native(absolute);
    if (directoryReal !== rootReal && !directoryReal.startsWith(`${rootReal}${sep}`)) {
      throw new Error("directory escapes workspace");
    }
    entries = readdirSync(absolute, { withFileTypes: true });
  } catch {
    throw new Error(`Build output directory is missing or unsafe: ${directory}`);
  }
  const files = [];
  for (const entry of entries.sort((left, right) => compareText(left.name, right.name))) {
    const path = resolve(absolute, entry.name);
    const relativePath = normalizedWorkspaceRelative(root, path);
    if (ignoredPaths.has(relativePath)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Build output contains a symbolic link: ${path}`);
    if (entry.isDirectory()) {
      files.push(...listRegularFiles(root, relativePath, ignoredPaths));
    } else if (entry.isFile()) {
      files.push(relativePath);
    } else {
      throw new Error(`Build output contains a non-regular entry: ${path}`);
    }
  }
  return files;
}

function decodeCanonicalSql(path) {
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
  } catch (error) {
    throw new Error(`Migration file is not valid UTF-8: ${path}`, { cause: error });
  }
  if (decoded.startsWith("\uFEFF")) decoded = decoded.slice(1);
  const canonical = decoded.replaceAll("\r\n", "\n");
  if (canonical.includes("\r")) {
    throw new Error(`Migration file contains an unsupported lone CR character: ${path}`);
  }
  return canonical;
}

/** The one migration plan used by both the release identity and the Hub executor. */
export function loadCanonicalMigrationPlan(migrationDir) {
  const names = readdirSync(migrationDir)
    .filter((name) => name.endsWith(".sql"))
    .sort(compareText);
  const byVersion = new Map();
  const plan = names.map((name) => {
    const match = /^(\d+)_(.+)\.sql$/u.exec(name);
    if (!match) throw new Error(`Invalid migration filename ${name}`);
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version <= 0) {
      throw new Error(`Invalid migration version in ${name}`);
    }
    const existing = byVersion.get(version);
    if (existing) {
      throw new Error(`Duplicate migration version ${version}: ${existing}, ${name}`);
    }
    byVersion.set(version, name);
    const sql = decodeCanonicalSql(resolve(migrationDir, name));
    return { version, name, sql, contentSha256: sha256(Buffer.from(sql, "utf8")) };
  });
  return plan.sort(
    (left, right) => left.version - right.version || compareText(left.name, right.name),
  );
}

function migrationPlanIdentity(plan) {
  return plan.map(({ version, name, contentSha256 }) => ({ version, name, contentSha256 }));
}

function parseFileRecord(value, label) {
  exactKeys(value, ["path", "sha256", "size"], label);
  assertRelativePath(value.path, label);
  if (!Number.isSafeInteger(value.size) || value.size < 0 || !SHA256.test(value.sha256)) {
    throw new Error(`Invalid ${label}`);
  }
  return { path: value.path, size: value.size, sha256: value.sha256 };
}

function parseComponent(value) {
  exactKeys(value, ["entrypoints", "name", "root", "sidecar"], "build component");
  if (typeof value.name !== "string" || typeof value.root !== "string") {
    throw new Error("Invalid build component");
  }
  assertRelativePath(value.root, "component root");
  assertRelativePath(value.sidecar, "component sidecar");
  if (!Array.isArray(value.entrypoints) || value.entrypoints.length === 0) {
    throw new Error("Invalid build component entrypoints");
  }
  const entrypoints = value.entrypoints.map((path) => {
    assertRelativePath(path, "component entrypoint");
    return path;
  });
  if (new Set(entrypoints).size !== entrypoints.length) {
    throw new Error("Duplicate build component entrypoint");
  }
  return { name: value.name, root: value.root, sidecar: value.sidecar, entrypoints };
}

function parseManifest(value) {
  exactKeys(
    value,
    [
      "artifacts",
      "buildId",
      "buildSessionId",
      "components",
      "createdAt",
      "migrationId",
      "migrations",
      "protocolId",
      "schemaVersion",
    ],
    "build manifest",
  );
  if (
    value.schemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION ||
    !UUID.test(value.buildSessionId) ||
    !SHA256.test(value.buildId) ||
    !SHA256.test(value.migrationId) ||
    !SHA256.test(value.protocolId) ||
    typeof value.createdAt !== "string" ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !Array.isArray(value.components) ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error("Invalid build manifest");
  }
  const components = value.components.map(parseComponent);
  const artifacts = value.artifacts.map((entry) => parseFileRecord(entry, "artifact"));
  exactKeys(value.migrations, ["files", "orderedSha256"], "migration manifest");
  if (!Array.isArray(value.migrations.files) || !SHA256.test(value.migrations.orderedSha256)) {
    throw new Error("Invalid migration manifest");
  }
  const migrations = value.migrations.files.map((entry) =>
    parseFileRecord(entry, "migration artifact"),
  );
  return {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    buildSessionId: value.buildSessionId,
    buildId: value.buildId,
    migrationId: value.migrationId,
    protocolId: value.protocolId,
    createdAt: value.createdAt,
    components,
    artifacts,
    migrations: { files: migrations, orderedSha256: value.migrations.orderedSha256 },
  };
}

function assertSortedUnique(values, label) {
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0 && compareText(values[index - 1], values[index]) >= 0) {
      throw new Error(`${label} must be sorted and unique`);
    }
  }
}

function expectedComponents() {
  return RELEASE_COMPONENTS.map((component) => ({
    name: component.name,
    root: component.root,
    sidecar: component.sidecar,
    entrypoints: [...component.entrypoints],
  }));
}

function assertManifestShape(manifest) {
  if (canonicalJson(manifest.components) !== canonicalJson(expectedComponents())) {
    throw new Error("Build manifest component set mismatch");
  }
  assertSortedUnique(
    manifest.artifacts.map(({ path }) => path),
    "Build artifacts",
  );
  assertSortedUnique(
    manifest.migrations.files.map(({ path }) => path),
    "Build migrations",
  );
  const artifactPaths = new Set(manifest.artifacts.map(({ path }) => path));
  for (const component of manifest.components) {
    for (const entrypoint of component.entrypoints) {
      if (!artifactPaths.has(entrypoint)) {
        throw new Error(`Build manifest is missing entrypoint: ${entrypoint}`);
      }
    }
  }
  const unsigned = {
    schemaVersion: manifest.schemaVersion,
    buildSessionId: manifest.buildSessionId,
    migrationId: manifest.migrationId,
    protocolId: manifest.protocolId,
    components: manifest.components,
    artifacts: manifest.artifacts,
    migrations: manifest.migrations,
  };
  if (sha256(canonicalJson(unsigned)) !== manifest.buildId) {
    throw new Error("Build manifest buildId mismatch");
  }
  const protocolArtifacts = manifest.artifacts.filter(({ path }) =>
    path.startsWith("packages/protocol/dist/"),
  );
  if (sha256(canonicalJson(protocolArtifacts)) !== manifest.protocolId) {
    throw new Error("Build manifest protocolId mismatch");
  }
  if (manifest.migrationId !== manifest.migrations.orderedSha256) {
    throw new Error("Build manifest migrationId mismatch");
  }
}

function parseLockPath(path, kinds) {
  if (!existsSync(path)) return null;
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Build lifecycle lock is malformed");
  }
  exactKeys(record, ["createdAt", "kind", "nonce", "pid"], "build lifecycle lock");
  if (
    !kinds.has(record.kind) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.nonce !== "string" ||
    !UUID.test(record.nonce) ||
    typeof record.createdAt !== "string" ||
    !Number.isFinite(Date.parse(record.createdAt))
  ) {
    throw new Error("Build lifecycle lock is malformed");
  }
  return record;
}

function parseLock(root) {
  return parseLockPath(resolve(root, BUILD_LOCK_RELATIVE_PATH), new Set(["BUILD", "RUNTIME"]));
}

export function findWorkspaceRoot(moduleUrl = import.meta.url) {
  let current = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const packagePath = resolve(current, "package.json");
    const workspacePath = resolve(current, "pnpm-workspace.yaml");
    if (existsSync(packagePath) && existsSync(workspacePath)) {
      try {
        const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
        if (packageJson?.name === "ayanami-agent-hub") return realpathSync.native(current);
      } catch {
        // Keep walking. A nested or malformed package.json is not the workspace marker.
      }
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("CrossAgent workspace root could not be resolved from the module URL");
}

function assertWorkspaceRoot(root) {
  const resolved = realpathSync.native(resolve(root));
  const packageJson = JSON.parse(readFileSync(resolve(resolved, "package.json"), "utf8"));
  if (
    packageJson?.name !== "ayanami-agent-hub" ||
    !existsSync(resolve(resolved, "pnpm-workspace.yaml"))
  ) {
    throw new Error("Invalid CrossAgent workspace root");
  }
  return resolved;
}

function verifyFileRecords(root, records, label) {
  for (const record of records) {
    const file = safeWorkspaceFile(root, record.path, label);
    const stat = statSync(file);
    if (stat.size !== record.size || sha256(readFileSync(file)) !== record.sha256) {
      throw new Error(`Build ${label} mismatch: ${record.path}`);
    }
  }
}

export function verifyReleaseBuild(options = {}) {
  const root = assertWorkspaceRoot(
    options.root ?? findWorkspaceRoot(options.moduleUrl ?? import.meta.url),
  );
  const lock = parseLock(root);
  if (lock?.kind === "BUILD") {
    if (
      options.allowBuildLockNonce === undefined ||
      lock.pid !== process.pid ||
      lock.nonce !== options.allowBuildLockNonce
    ) {
      throw new Error("Build is currently in progress; refusing to use a partial release");
    }
  }
  const { bytes: manifestBytes, value } = readJsonFile(
    root,
    BUILD_MANIFEST_RELATIVE_PATH,
    "manifest",
  );
  const manifest = parseManifest(value);
  assertManifestShape(manifest);
  if (options.expectedBuildId !== undefined && manifest.buildId !== options.expectedBuildId) {
    throw new Error("Hub expected build identity does not match the verified release");
  }
  verifyFileRecords(root, manifest.artifacts, "artifact");
  verifyFileRecords(root, manifest.migrations.files, "migration artifact");
  const actualArtifacts = RELEASE_COMPONENTS.flatMap((component) =>
    listRegularFiles(root, `${component.root}/dist`, new Set([component.sidecar])),
  ).sort(compareText);
  if (
    canonicalJson(actualArtifacts) !== canonicalJson(manifest.artifacts.map(({ path }) => path))
  ) {
    throw new Error("Build artifact set mismatch");
  }
  const actualMigrations = listRegularFiles(root, "migrations")
    .filter((path) => path.endsWith(".sql"))
    .sort(compareText);
  if (
    canonicalJson(actualMigrations) !==
    canonicalJson(manifest.migrations.files.map(({ path }) => path))
  ) {
    throw new Error("Build migration set mismatch");
  }
  const migrationPlan = loadCanonicalMigrationPlan(resolve(root, "migrations"));
  if (
    sha256(canonicalJson(migrationPlanIdentity(migrationPlan))) !==
    manifest.migrations.orderedSha256
  ) {
    throw new Error("Build manifest migration ordered hash mismatch");
  }
  for (const component of manifest.components) {
    const { value: rawSidecar } = readJsonFile(root, component.sidecar, "component sidecar");
    exactKeys(
      rawSidecar,
      ["buildId", "buildSessionId", "component", "migrationId", "protocolId", "schemaVersion"],
      "component sidecar",
    );
    if (
      rawSidecar.schemaVersion !== BUILD_MANIFEST_SCHEMA_VERSION ||
      rawSidecar.component !== component.name ||
      rawSidecar.buildSessionId !== manifest.buildSessionId ||
      rawSidecar.buildId !== manifest.buildId ||
      rawSidecar.migrationId !== manifest.migrationId ||
      rawSidecar.protocolId !== manifest.protocolId
    ) {
      throw new Error(`Build component sidecar mismatch: ${component.name}`);
    }
  }
  return Object.freeze({
    buildSessionId: manifest.buildSessionId,
    buildId: manifest.buildId,
    migrationId: manifest.migrationId,
    protocolId: manifest.protocolId,
    manifestSha256: sha256(manifestBytes),
  });
}

export function assertExactBuildIdentity(expected, actual, label = "Runtime") {
  if (
    !actual ||
    expected.buildSessionId !== actual.buildSessionId ||
    expected.buildId !== actual.buildId ||
    expected.migrationId !== actual.migrationId ||
    expected.protocolId !== actual.protocolId ||
    expected.manifestSha256 !== actual.manifestSha256
  ) {
    throw new Error(`${label} build identity mismatch`);
  }
}

export function serializeRuntimeBuildIdentity(identity) {
  return canonicalJson(parseRuntimeBuildIdentityRecord(identity));
}

export function parseSerializedRuntimeBuildIdentity(serialized) {
  if (typeof serialized !== "string" || serialized.length === 0 || serialized.length > 4096) {
    throw new Error("Invalid serialized runtime build identity");
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Invalid serialized runtime build identity");
  }
  return parseRuntimeBuildIdentityRecord(value);
}

export function formatReleaseBuildResult(identity) {
  return JSON.stringify(parseRuntimeBuildIdentityRecord(identity));
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission denial proves the PID exists; treating it as dead would make stale-lock recovery
    // delete another live owner's lock.
    return error?.code === "EPERM";
  }
}

function sameLockRecord(left, right) {
  return (
    left?.kind === right.kind &&
    left?.pid === right.pid &&
    left?.nonce === right.nonce &&
    left?.createdAt === right.createdAt
  );
}

function writeExclusiveJson(path, value) {
  let descriptor;
  try {
    descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    return true;
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error?.code === "EEXIST") return false;
    throw error;
  }
}

function reaperPrefix(path) {
  return `${path}.reap.`;
}

function reaperEntries(path) {
  const prefix = `${path.split(sep).at(-1)}.reap.`;
  return readdirSync(dirname(path))
    .filter((name) => name.startsWith(prefix))
    .map((name) => resolve(dirname(path), name));
}

function retireExactPath(path, expected, kinds, suffix) {
  const current = parseLockPath(path, kinds);
  if (!sameLockRecord(current, expected)) return false;
  const tombstone = `${path}.${suffix}.${randomUUID()}`;
  try {
    renameSync(path, tombstone);
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
  const retired = parseLockPath(tombstone, kinds);
  if (!sameLockRecord(retired, expected)) {
    throw new Error("Build lifecycle lock identity changed during retirement");
  }
  unlinkSync(tombstone);
  return true;
}

function cleanupAbandonedReapers(path, targetKinds) {
  const entries = reaperEntries(path);
  const claims = entries.filter((entry) => !entry.endsWith(".stale"));
  for (const claimPath of claims) {
    const claim = parseLockPath(claimPath, new Set(["REAPER"]));
    if (!claim) continue;
    if (processExists(claim.pid)) {
      throw new Error("Build lifecycle stale-lock recovery is in progress");
    }
    for (const tombstone of entries.filter(
      (entry) => entry.startsWith(`${claimPath}.`) && entry.endsWith(".stale"),
    )) {
      const retired = parseLockPath(tombstone, targetKinds);
      if (!retired) throw new Error("Build lifecycle stale-lock tombstone is malformed");
      unlinkSync(tombstone);
    }
    retireExactPath(claimPath, claim, new Set(["REAPER"]), "retired");
  }
  const remainingClaims = reaperEntries(path).filter((entry) => !entry.endsWith(".stale"));
  if (remainingClaims.length === 0) {
    for (const orphan of reaperEntries(path).filter((entry) => entry.endsWith(".stale"))) {
      const retired = parseLockPath(orphan, targetKinds);
      if (!retired) throw new Error("Build lifecycle stale-lock tombstone is malformed");
      unlinkSync(orphan);
    }
  }
}

/**
 * Retire one exact dead record without an unlink-by-path ABA. All cooperative acquirers discard a
 * newly-created lock while a reaper marker exists, so the rename gap cannot publish two owners.
 */
function retireDeadLock(path, expected, kinds, onStaleLockObserved) {
  onStaleLockObserved?.(Object.freeze({ ...expected }));
  const claimPath = `${reaperPrefix(path)}${expected.nonce}`;
  const claim = {
    kind: "REAPER",
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  if (!writeExclusiveJson(claimPath, claim)) return false;
  const tombstone = `${claimPath}.${claim.nonce}.stale`;
  try {
    const current = parseLockPath(path, kinds);
    if (!sameLockRecord(current, expected) || processExists(expected.pid)) return false;
    renameSync(path, tombstone);
    const retired = parseLockPath(tombstone, kinds);
    if (!sameLockRecord(retired, expected)) {
      throw new Error("Build lifecycle stale-lock identity changed during retirement");
    }
    unlinkSync(tombstone);
    return true;
  } finally {
    if (existsSync(claimPath)) {
      retireExactPath(claimPath, claim, new Set(["REAPER"]), "released");
    }
  }
}

function acquirePathLock(root, path, kind, kinds, options = {}) {
  mkdirSync(dirname(path), { recursive: true });
  const record = {
    kind,
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    cleanupAbandonedReapers(path, kinds);
    if (writeExclusiveJson(path, record)) {
      if (reaperEntries(path).length === 0) {
        return Object.freeze({ root, path, record: Object.freeze(record) });
      }
      const current = parseLockPath(path, kinds);
      if (sameLockRecord(current, record)) unlinkSync(path);
      continue;
    }
    const existing = parseLockPath(path, kinds);
    if (!existing || processExists(existing.pid)) {
      throw new Error(`Build lifecycle is busy (${existing?.kind ?? "UNKNOWN"})`);
    }
    retireDeadLock(path, existing, kinds, options.onStaleLockObserved);
  }
  throw new Error("Build lifecycle lock could not be acquired");
}

export function acquireReleaseLifecycleLock(rootInput, kind, options = {}) {
  const root = assertWorkspaceRoot(rootInput);
  const path = resolve(root, BUILD_LOCK_RELATIVE_PATH);
  const lock = acquirePathLock(root, path, kind, new Set(["BUILD", "RUNTIME"]), options);
  if (kind === "BUILD") {
    try {
      assertNoActiveHubRuntime(root);
    } catch (error) {
      releaseReleaseLifecycleLock(lock);
      throw error;
    }
  }
  return lock;
}

export function releaseReleaseLifecycleLock(lock) {
  const current = parseLock(lock.root);
  if (
    !current ||
    current.kind !== lock.record.kind ||
    current.pid !== lock.record.pid ||
    current.nonce !== lock.record.nonce
  ) {
    throw new Error("Build lifecycle lock ownership changed");
  }
  unlinkSync(lock.path);
}

export async function withReleaseLifecycleLock(root, kind, operation) {
  const lock = acquireReleaseLifecycleLock(root, kind);
  try {
    return await operation(lock);
  } finally {
    releaseReleaseLifecycleLock(lock);
  }
}

export function acquireHubRuntimeLease(rootInput, options = {}) {
  const root = assertWorkspaceRoot(rootInput);
  return acquirePathLock(
    root,
    resolve(root, HUB_RUNTIME_LOCK_RELATIVE_PATH),
    "HUB_RUNTIME",
    new Set(["HUB_RUNTIME"]),
    options,
  );
}

export function releaseHubRuntimeLease(lock) {
  const current = parseLockPath(lock.path, new Set(["HUB_RUNTIME"]));
  if (!sameLockRecord(current, lock.record)) {
    throw new Error("Hub runtime lease ownership changed");
  }
  unlinkSync(lock.path);
}

/**
 * The pid of a Hub already serving this workspace, or null.
 *
 * Read-only on purpose: it retires nothing and throws for no reason, so a diagnostic path can ask
 * without side effects. One Hub holds this lease per built workspace, which is why a second one
 * fails even on its own port and data directory -- a fact worth being able to say out loud.
 */
export function activeHubRuntimePid(rootInput) {
  const root = assertWorkspaceRoot(rootInput);
  const existing = parseLockPath(
    resolve(root, HUB_RUNTIME_LOCK_RELATIVE_PATH),
    new Set(["HUB_RUNTIME"]),
  );
  return existing && processExists(existing.pid) ? existing.pid : null;
}

export function assertNoActiveHubRuntime(rootInput) {
  const root = assertWorkspaceRoot(rootInput);
  const path = resolve(root, HUB_RUNTIME_LOCK_RELATIVE_PATH);
  const existing = parseLockPath(path, new Set(["HUB_RUNTIME"]));
  if (!existing) return;
  if (processExists(existing.pid)) {
    throw new Error("A Hub is serving this workspace release; refusing an in-place build");
  }
  if (!retireDeadLock(path, existing, new Set(["HUB_RUNTIME"]))) {
    throw new Error("Hub runtime lease recovery is busy");
  }
}

/**
 * A component package may mutate dist only while the root release builder still owns the exact
 * BUILD lock advertised to the child. Re-reading the lock closes stale/fake environment handoffs.
 */
export function assertAuthorizedComponentBuild(rootInput, environment = process.env) {
  const root = assertWorkspaceRoot(rootInput);
  const advertisedPid = Number(environment.CROSSAGENT_ROOT_BUILD_PID);
  const advertisedNonce = environment.CROSSAGENT_ROOT_BUILD_NONCE;
  if (
    !Number.isSafeInteger(advertisedPid) ||
    advertisedPid <= 0 ||
    typeof advertisedNonce !== "string" ||
    !UUID.test(advertisedNonce)
  ) {
    throw new Error("Component builds must be invoked by the root release builder");
  }
  const current = parseLock(root);
  if (
    current?.kind !== "BUILD" ||
    current.pid !== advertisedPid ||
    current.nonce !== advertisedNonce ||
    !processExists(current.pid)
  ) {
    throw new Error("Component build authorization does not match the current BUILD lock");
  }
  assertNoActiveHubRuntime(root);
  return Object.freeze({ ...current });
}

export function assertNoLegacyManagedHub(environment = process.env) {
  const dataDir = resolve(environment.CROSSAGENT_DATA_DIR ?? resolve(homedir(), ".crossagent"));
  const path = resolve(dataDir, "hub.pid.json");
  if (!existsSync(path)) return;
  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Managed Hub PID record is malformed; refusing an in-place build");
  }
  if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) {
    throw new Error("Managed Hub PID record is malformed; refusing an in-place build");
  }
  if (processExists(record.pid)) {
    throw new Error("A managed Hub process is still running; refusing an in-place build");
  }
}

function fileRecords(root, paths) {
  return [...paths].sort(compareText).map((path) => {
    const file = safeWorkspaceFile(root, path, "release artifact");
    const bytes = readFileSync(file);
    return { path, size: bytes.byteLength, sha256: sha256(bytes) };
  });
}

export function createReleaseManifest(
  rootInput,
  buildSessionId,
  createdAt = new Date().toISOString(),
) {
  const root = assertWorkspaceRoot(rootInput);
  if (!UUID.test(buildSessionId)) throw new Error("Invalid build session ID");
  const components = expectedComponents();
  const artifactPaths = RELEASE_COMPONENTS.flatMap((component) =>
    listRegularFiles(root, `${component.root}/dist`, new Set([component.sidecar])),
  );
  const artifacts = fileRecords(root, artifactPaths);
  const migrationPaths = listRegularFiles(root, "migrations").filter((path) =>
    path.endsWith(".sql"),
  );
  const migrationFiles = fileRecords(root, migrationPaths);
  const migrationPlan = loadCanonicalMigrationPlan(resolve(root, "migrations"));
  const migrations = {
    files: migrationFiles,
    orderedSha256: sha256(canonicalJson(migrationPlanIdentity(migrationPlan))),
  };
  const migrationId = migrations.orderedSha256;
  const protocolId = sha256(
    canonicalJson(artifacts.filter(({ path }) => path.startsWith("packages/protocol/dist/"))),
  );
  const unsigned = {
    schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
    buildSessionId,
    migrationId,
    protocolId,
    components,
    artifacts,
    migrations,
  };
  const buildId = sha256(canonicalJson(unsigned));
  return { ...unsigned, buildId, createdAt };
}

export function writeReleaseIdentity(rootInput, manifest) {
  const root = assertWorkspaceRoot(rootInput);
  for (const component of manifest.components) {
    atomicWriteJson(resolve(root, component.sidecar), {
      schemaVersion: BUILD_MANIFEST_SCHEMA_VERSION,
      component: component.name,
      buildSessionId: manifest.buildSessionId,
      buildId: manifest.buildId,
      migrationId: manifest.migrationId,
      protocolId: manifest.protocolId,
    });
  }
  atomicWriteJson(resolve(root, BUILD_MANIFEST_RELATIVE_PATH), manifest);
}

export function verifiedReleaseEntrypoint(rootInput, relativePath, expectedIdentity) {
  const root = assertWorkspaceRoot(rootInput);
  if (!RELEASE_COMPONENTS.some((component) => component.entrypoints.includes(relativePath))) {
    throw new Error(`Release entrypoint is not declared: ${relativePath}`);
  }
  const actual = verifyReleaseBuild({ root });
  if (expectedIdentity) assertExactBuildIdentity(expectedIdentity, actual, "Release entrypoint");
  return safeWorkspaceFile(root, relativePath, "entrypoint");
}

function parseRuntimeBuildIdentityRecord(value) {
  exactKeys(
    value,
    ["buildId", "buildSessionId", "manifestSha256", "migrationId", "protocolId"],
    "runtime build identity",
  );
  if (
    !UUID.test(value.buildSessionId) ||
    !SHA256.test(value.buildId) ||
    !SHA256.test(value.migrationId) ||
    !SHA256.test(value.protocolId) ||
    !SHA256.test(value.manifestSha256)
  ) {
    throw new Error("Invalid runtime build identity");
  }
  return Object.freeze({
    buildSessionId: value.buildSessionId,
    buildId: value.buildId,
    migrationId: value.migrationId,
    protocolId: value.protocolId,
    manifestSha256: value.manifestSha256,
  });
}

function parseHubShutdownReceipt(value) {
  exactKeys(
    value,
    [
      "buildIdentity",
      "idempotencyKey",
      "instanceId",
      "pid",
      "schemaVersion",
      "startedAt",
      "stoppedAt",
    ],
    "Hub shutdown receipt",
  );
  if (
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.instanceId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(value.instanceId) ||
    !UUID.test(value.idempotencyKey) ||
    typeof value.startedAt !== "string" ||
    !Number.isFinite(Date.parse(value.startedAt)) ||
    typeof value.stoppedAt !== "string" ||
    !Number.isFinite(Date.parse(value.stoppedAt))
  ) {
    throw new Error("Invalid Hub shutdown receipt");
  }
  return Object.freeze({
    schemaVersion: 1,
    pid: value.pid,
    instanceId: value.instanceId,
    buildIdentity: parseRuntimeBuildIdentityRecord(value.buildIdentity),
    idempotencyKey: value.idempotencyKey,
    startedAt: value.startedAt,
    stoppedAt: value.stoppedAt,
  });
}

export function writeHubShutdownReceipt(dataDir, receipt) {
  const parsed = parseHubShutdownReceipt({ schemaVersion: 1, ...receipt });
  atomicWriteJson(resolve(dataDir, HUB_SHUTDOWN_RECEIPT_NAME), parsed);
  return parsed;
}

export function readHubShutdownReceipt(dataDir) {
  const path = resolve(dataDir, HUB_SHUTDOWN_RECEIPT_NAME);
  if (!existsSync(path)) return null;
  return parseHubShutdownReceipt(JSON.parse(readFileSync(path, "utf8")));
}

function atomicWriteJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
    throw error;
  }
}
