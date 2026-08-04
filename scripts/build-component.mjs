import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  RELEASE_COMPONENTS,
  assertAuthorizedComponentBuild,
  findWorkspaceRoot,
} from "./build-identity.mjs";

const [componentName, separator, tool, ...toolArgs] = process.argv.slice(2);
if (!componentName || separator !== "--" || !tool) {
  throw new Error("Usage: build-component <component> -- <tool> [...args]");
}

const workspaceRoot = findWorkspaceRoot(import.meta.url);
const component = RELEASE_COMPONENTS.find((candidate) => candidate.name === componentName);
if (!component) throw new Error(`Unknown release component: ${componentName}`);

const componentRoot = realpathSync.native(resolve(workspaceRoot, component.root));
if (realpathSync.native(process.cwd()) !== componentRoot) {
  throw new Error(`Component build cwd does not match ${component.name}`);
}
assertAuthorizedComponentBuild(workspaceRoot, process.env);

const pnpmEntrypoint = process.env.npm_execpath;
if (!pnpmEntrypoint || !existsSync(pnpmEntrypoint)) {
  throw new Error("Component builds require the repository pnpm runtime");
}
const result = spawnSync(process.execPath, [pnpmEntrypoint, "exec", tool, ...toolArgs], {
  cwd: componentRoot,
  env: process.env,
  stdio: "inherit",
  windowsHide: true,
});
if (result.error) throw result.error;
if (result.status !== 0) {
  throw new Error(
    `Component build failed for ${component.name} with exit code ${result.status ?? "unknown"}`,
  );
}
