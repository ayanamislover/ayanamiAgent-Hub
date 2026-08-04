import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { RELEASE_COMPONENTS, findWorkspaceRoot, verifyReleaseBuild } from "./build-identity.mjs";

/**
 * Packs an already-verified release into a zip that runs on a machine with nothing but Node
 * installed: no pnpm, no compiler, no network. The layout inside the zip is deliberately the
 * workspace layout, because `verifyHubRuntimeRelease` resolves `migrations`, `apps/dashboard/dist`
 * and every manifest entrypoint from the directory that holds `package.json` + `pnpm-workspace.yaml`.
 * A flattened "bin/" style tree would fail its own integrity check on first start.
 */

const PLATFORM = "win-x64";
/** Every project that is entered as a process, so each needs a resolvable dependency tree. */
const RUNTIME_ROOTS = Object.freeze([
  // The Hub carries the largest closure, so its tree becomes the shared one at the package root.
  Object.freeze({ name: "@crossagent/hub", root: "apps/hub", shared: true }),
  Object.freeze({ name: "@crossagent/cli", root: "packages/cli", shared: false }),
  Object.freeze({
    name: "@crossagent/claude-channel",
    root: "packages/claude-channel",
    shared: false,
  }),
  Object.freeze({ name: "@crossagent/hooks", root: "packages/hooks", shared: false }),
]);
/** Documentation and launchers copied verbatim; none of them needs pnpm or a source tree. */
const VERBATIM_PATHS = Object.freeze([
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "SECURITY.md",
  "docs",
  "migrations",
  "pnpm-workspace.yaml",
  "scripts/connect-claude.ps1",
  "scripts/connect-codex.ps1",
  "scripts/stop-windows.ps1",
  "Connect-Claude.cmd",
  "Connect-Codex.cmd",
  "Stop-CrossAgent-Hub.cmd",
]);
/** pnpm bookkeeping that means nothing once the tree is copied out of the workspace. */
const DEPLOY_ARTEFACTS = Object.freeze([".bin", ".modules.yaml", ".package-map.json", ".pnpm"]);

if (process.platform !== "win32") {
  throw new Error(`The ${PLATFORM} package can only be built on Windows: it ships native addons`);
}

const workspaceRoot = findWorkspaceRoot(import.meta.url);
const rootPackage = JSON.parse(readFileSync(resolve(workspaceRoot, "package.json"), "utf8"));
const packageName = `crossagent-hub-v${rootPackage.version}-${PLATFORM}`;
const outputRoot = resolve(workspaceRoot, "output", "release");
const stagingRoot = resolve(outputRoot, packageName);
const deployRoot = resolve(outputRoot, ".deploy");
const archivePath = resolve(outputRoot, `${packageName}.zip`);

function step(message) {
  process.stdout.write(`[package-release] ${message}\n`);
}

function fromWorkspace(...parts) {
  return resolve(workspaceRoot, ...parts);
}

function fromStaging(...parts) {
  return resolve(stagingRoot, ...parts);
}

const workspaceStatePath = fromWorkspace("node_modules", ".pnpm-workspace-state-v1.json");

function readWorkspaceDependencyState() {
  try {
    return readFileSync(workspaceStatePath);
  } catch {
    return null;
  }
}

/**
 * `pnpm deploy` rewrites this repository's own dependency-status cache with the settings the deploy
 * ran under -- production-only, hoisted linker. It never touches the real install, but the next
 * `pnpm <script>` here compares against that cache, concludes the installed tree is wrong, and
 * offers to purge node_modules. Putting the cache back is the entire repair.
 */
function restoreWorkspaceDependencyState(saved) {
  if (saved) writeFileSync(workspaceStatePath, saved);
  else rmSync(workspaceStatePath, { force: true });
}

function run(executable, args, label) {
  const result = spawnSync(executable, args, {
    cwd: workspaceRoot,
    stdio: ["ignore", "ignore", "inherit"],
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status ?? "unknown"}`);
  }
}

/**
 * `pnpm deploy` is the only supported way to turn pnpm's symlinked store into a tree that survives
 * being zipped. `--legacy` because this workspace does not inject its workspace packages, and
 * `node-linker=hoisted` because a Windows zip cannot carry the `.pnpm` symlink farm.
 */
function deployRuntimeRoot(runtimeRoot) {
  const pnpmEntrypoint = process.env.npm_execpath;
  if (!pnpmEntrypoint || !existsSync(pnpmEntrypoint)) {
    throw new Error("The release packager must be invoked through the repository pnpm script");
  }
  const target = resolve(deployRoot, runtimeRoot.root.replace(/\//gu, "-"));
  rmSync(target, { recursive: true, force: true });
  // Same reason as scripts/build-release.mjs: Node on Windows refuses to spawnSync a .cmd shim, and
  // shell:true would weaken argument boundaries for paths containing spaces.
  run(
    process.execPath,
    [
      pnpmEntrypoint,
      "--filter",
      runtimeRoot.name,
      "deploy",
      "--prod",
      "--legacy",
      "--config.node-linker=hoisted",
      target,
    ],
    `pnpm deploy ${runtimeRoot.name}`,
  );
  const nodeModules = resolve(target, "node_modules");
  if (!existsSync(nodeModules)) {
    throw new Error(`pnpm deploy produced no dependency tree for ${runtimeRoot.name}`);
  }
  for (const artefact of DEPLOY_ARTEFACTS) {
    rmSync(resolve(nodeModules, artefact), { recursive: true, force: true });
  }
  // node-pty ships a prebuild per platform, and the ConPTY payload alone is ~30 MB each. A package
  // named win-x64 has no use for the other three.
  const prebuilds = resolve(nodeModules, "node-pty", "prebuilds");
  if (existsSync(prebuilds)) {
    for (const platform of readdirSync(prebuilds)) {
      if (platform !== "win32-x64") rmSync(resolve(prebuilds, platform), { recursive: true });
    }
  }
  return nodeModules;
}

/** Top-level package names in a node_modules directory, scopes expanded to `@scope/name`. */
function installedPackages(nodeModules) {
  const names = [];
  for (const entry of readdirSync(nodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (!entry.name.startsWith("@")) {
      names.push(entry.name);
      continue;
    }
    for (const scoped of readdirSync(resolve(nodeModules, entry.name), { withFileTypes: true })) {
      if (scoped.isDirectory()) names.push(`${entry.name}/${scoped.name}`);
    }
  }
  return names.sort();
}

function readInstalledVersion(directory) {
  try {
    const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function hashDirectory(directory) {
  const digest = createHash("sha256");
  const walk = (current, prefix) => {
    const entries = readdirSync(current, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = resolve(current, entry.name);
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        digest.update(`d ${relativePath}\n`);
        walk(path, relativePath);
      } else {
        digest.update(`f ${relativePath} `);
        digest.update(createHash("sha256").update(readFileSync(path)).digest());
        digest.update("\n");
      }
    }
  };
  walk(directory, "");
  return digest.digest("hex");
}

/**
 * Each deployed tree is exactly what pnpm resolved for that one project, so a package left in a
 * project's own node_modules is either a duplicate of the shared copy or a version that project
 * genuinely needs to see instead. Node resolves upward, so dropping the byte-identical duplicates
 * lands every consumer on the same bytes one level up; anything that differs stays where pnpm put
 * it, which is the only thing keeping the two `content-disposition` majors apart.
 */
function dropDuplicatesOfSharedTree(sharedNodeModules, projectNodeModules) {
  let dropped = 0;
  for (const name of installedPackages(projectNodeModules)) {
    const shared = resolve(sharedNodeModules, name);
    const local = resolve(projectNodeModules, name);
    if (!existsSync(shared)) continue;
    const sharedVersion = readInstalledVersion(shared);
    if (sharedVersion === null || sharedVersion !== readInstalledVersion(local)) continue;
    if (hashDirectory(shared) !== hashDirectory(local)) continue;
    rmSync(local, { recursive: true });
    dropped += 1;
  }
  // Removing the last member of a scope leaves an empty `@scope` directory behind.
  for (const entry of readdirSync(projectNodeModules, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("@")) continue;
    const scope = resolve(projectNodeModules, entry.name);
    if (readdirSync(scope).length === 0) rmSync(scope, { recursive: true });
  }
  return dropped;
}

function collectSoftwareBillOfMaterials() {
  const seen = new Map();
  const trees = [fromStaging("node_modules")];
  for (const runtimeRoot of RUNTIME_ROOTS) {
    if (!runtimeRoot.shared) trees.push(fromStaging(runtimeRoot.root, "node_modules"));
  }
  for (const tree of trees) {
    if (!existsSync(tree)) continue;
    for (const name of installedPackages(tree)) {
      const directory = resolve(tree, name);
      const manifest = JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
      const version = typeof manifest.version === "string" ? manifest.version : "unknown";
      const key = `${name}@${version}`;
      if (seen.has(key)) continue;
      seen.set(key, {
        name,
        version,
        license: typeof manifest.license === "string" ? manifest.license : "NOASSERTION",
      });
    }
  }
  return [...seen.values()].sort((left, right) =>
    `${left.name}@${left.version}` < `${right.name}@${right.version}` ? -1 : 1,
  );
}

function writeSoftwareBillOfMaterials(identity, components) {
  const reference = (component) =>
    `SPDXRef-Package-${`${component.name}-${component.version}`.replace(/[^a-zA-Z0-9.-]/gu, "-")}`;
  const document = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: packageName,
    // The build id is the only globally unique thing this release has; it keeps the namespace of
    // two packages built from the same version but different sources apart.
    documentNamespace: `https://crossagent.invalid/spdx/${packageName}/${identity.buildId}`,
    creationInfo: {
      created: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
      creators: ["Tool: crossagent-package-release"],
    },
    packages: [
      {
        SPDXID: "SPDXRef-Package-crossagent-hub",
        name: "ayanami-agent-hub",
        versionInfo: rootPackage.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: rootPackage.license,
        licenseDeclared: rootPackage.license,
        supplier: "NOASSERTION",
      },
      ...components.map((component) => ({
        SPDXID: reference(component),
        name: component.name,
        versionInfo: component.version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: component.license,
        licenseDeclared: component.license,
        supplier: "NOASSERTION",
        externalRefs: [
          {
            referenceCategory: "PACKAGE-MANAGER",
            referenceType: "purl",
            referenceLocator: `pkg:npm/${component.name}@${component.version}`,
          },
        ],
      })),
    ],
    relationships: [
      {
        spdxElementId: "SPDXRef-DOCUMENT",
        relationshipType: "DESCRIBES",
        relatedSpdxElement: "SPDXRef-Package-crossagent-hub",
      },
      ...components.map((component) => ({
        spdxElementId: "SPDXRef-Package-crossagent-hub",
        relationshipType: "CONTAINS",
        relatedSpdxElement: reference(component),
      })),
    ],
  };
  writeFileSync(fromStaging("SBOM.spdx.json"), `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return document.packages.length;
}

step(`verifying the release build in ${workspaceRoot}`);
const identity = verifyReleaseBuild({ root: workspaceRoot });
step(`build ${identity.buildId.slice(0, 12)} verified; packaging ${packageName}`);

rmSync(stagingRoot, { recursive: true, force: true });
rmSync(archivePath, { force: true });
rmSync(deployRoot, { recursive: true, force: true });
mkdirSync(stagingRoot, { recursive: true });

for (const path of VERBATIM_PATHS) {
  cpSync(fromWorkspace(path), fromStaging(path), { recursive: true });
}
// The runtime reads the manifest to prove the dist it is about to execute is the one that was
// built; nothing else in .crossagent-build survives the trip, least of all a runtime lease.
mkdirSync(fromStaging(".crossagent-build"), { recursive: true });
cpSync(
  fromWorkspace(".crossagent-build", "release-manifest.json"),
  fromStaging(".crossagent-build", "release-manifest.json"),
);
for (const component of RELEASE_COMPONENTS) {
  cpSync(fromWorkspace(component.root, "dist"), fromStaging(component.root, "dist"), {
    recursive: true,
  });
  cpSync(
    fromWorkspace(component.root, "package.json"),
    fromStaging(component.root, "package.json"),
  );
}
// A trimmed root manifest: `findWorkspaceRoot` only matches on the name, and advertising scripts
// that need a source tree, or a package manager nobody has to install, would only mislead.
writeFileSync(
  fromStaging("package.json"),
  `${JSON.stringify(
    {
      name: rootPackage.name,
      version: rootPackage.version,
      private: true,
      license: rootPackage.license,
      type: rootPackage.type,
      engines: { node: `>=${process.versions.node.split(".")[0]}.0.0` },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const nodeModulesByRoot = new Map();
const savedWorkspaceState = readWorkspaceDependencyState();
try {
  for (const runtimeRoot of RUNTIME_ROOTS) {
    step(`deploying the dependency tree for ${runtimeRoot.name}`);
    nodeModulesByRoot.set(runtimeRoot.root, deployRuntimeRoot(runtimeRoot));
  }
} finally {
  restoreWorkspaceDependencyState(savedWorkspaceState);
}
const sharedRoot = RUNTIME_ROOTS.find((runtimeRoot) => runtimeRoot.shared);
cpSync(nodeModulesByRoot.get(sharedRoot.root), fromStaging("node_modules"), { recursive: true });
for (const runtimeRoot of RUNTIME_ROOTS) {
  if (runtimeRoot.shared) continue;
  const target = fromStaging(runtimeRoot.root, "node_modules");
  cpSync(nodeModulesByRoot.get(runtimeRoot.root), target, { recursive: true });
  const dropped = dropDuplicatesOfSharedTree(fromStaging("node_modules"), target);
  step(`${runtimeRoot.name}: ${dropped} duplicate packages folded into the shared tree`);
}
rmSync(deployRoot, { recursive: true, force: true });

writeFileSync(
  fromStaging("release.json"),
  `${JSON.stringify(
    {
      product: "CrossAgent Hub",
      version: rootPackage.version,
      platform: PLATFORM,
      createdAt: new Date().toISOString(),
      build: {
        buildId: identity.buildId,
        buildSessionId: identity.buildSessionId,
        migrationId: identity.migrationId,
        protocolId: identity.protocolId,
        manifestSha256: identity.manifestSha256,
      },
      // better-sqlite3 and node-pty are compiled addons: they load only into the Node ABI they were
      // built against, so the launcher refuses anything else rather than failing inside a require.
      node: {
        abi: process.versions.modules,
        builtWith: process.versions.node,
        major: Number(process.versions.node.split(".")[0]),
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

const components = collectSoftwareBillOfMaterials();
const listed = writeSoftwareBillOfMaterials(identity, components);
step(`recorded ${listed} packages in SBOM.spdx.json`);

cpSync(
  fromWorkspace("scripts", "start-portable.ps1"),
  fromStaging("scripts", "start-portable.ps1"),
);
writeFileSync(
  fromStaging("Start-CrossAgent-Hub.cmd"),
  [
    "@echo off",
    "setlocal",
    "chcp 65001 >nul",
    'cd /d "%~dp0"',
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\\start-portable.ps1" %*',
    'set "CROSSAGENT_EXIT=%ERRORLEVEL%"',
    "if not defined CROSSAGENT_NO_PAUSE pause",
    "exit /b %CROSSAGENT_EXIT%",
    "",
  ].join("\r\n"),
  "utf8",
);

step("compressing");
// bsdtar ships with Windows 10 and later and writes a real zip from the extension. Compress-Archive
// would take minutes on a tree this size and trips over long paths inside node_modules.
run(
  resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
  ["-a", "-c", "-f", archivePath, "-C", outputRoot, packageName],
  "bsdtar",
);

const archive = readFileSync(archivePath);
const archiveSha256 = createHash("sha256").update(archive).digest("hex");
writeFileSync(
  resolve(outputRoot, "SHA256SUMS.txt"),
  `${archiveSha256} *${packageName}.zip\n`,
  "utf8",
);

step(`${packageName}.zip -- ${(archive.length / 1024 / 1024).toFixed(1)} MiB`);
step(`sha256 ${archiveSha256}`);
step(`written to ${outputRoot}`);
