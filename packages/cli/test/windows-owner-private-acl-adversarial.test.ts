import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hardenWindowsOwnerPrivateAcl,
  verifyWindowsOwnerPrivateAcl,
} from "../src/windows-owner-private-acl.js";

const roots: string[] = [];
const isWindows = process.platform === "win32";
const COMMAND_TIMEOUT_MS = 10_000;
const COMMAND_MAX_BUFFER_BYTES = 4 * 1024;
// Link creation capability is probed before test registration so skipped tests are explicitly
// attributable only to Windows permission policy, never to an assertion or setup failure.
const canCreateJunction = isWindows && canCreateTestLink("junction");
const canCreateSymbolicLink = isWindows && canCreateTestLink("symbolic-link");

const ADD_EVERYONE_READ_ACE = String.raw`
$ErrorActionPreference = 'Stop'
$literalPath = [string]$env:CROSSAGENT_ACL_TEST_PATH
$acl = [System.IO.File]::GetAccessControl($literalPath)
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$read = [System.Security.AccessControl.FileSystemRights]::Read
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($everyone, $read, $allow)
[void]$acl.AddAccessRule($rule)
[System.IO.File]::SetAccessControl($literalPath, $acl)
`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows owner-private ACL adversarial cases", () => {
  it.runIf(isWindows)(
    "rejects a foreign Allow ACE and restores the private ACL on re-harden",
    () => {
      const root = makeTempRoot();
      const file = resolve(root, "owner-private.json");
      writeFileSync(file, "{}\n", "utf8");

      expect(hardenWindowsOwnerPrivateAcl(file, "file")).toBe(true);
      expect(verifyWindowsOwnerPrivateAcl(file)).toBe(true);

      runWindowsPowerShell(ADD_EVERYONE_READ_ACE, file);
      expect(verifyWindowsOwnerPrivateAcl(file)).toBe(false);

      expect(hardenWindowsOwnerPrivateAcl(file, "file")).toBe(true);
      expect(verifyWindowsOwnerPrivateAcl(file)).toBe(true);
    },
  );

  it.skipIf(!isWindows || !canCreateJunction)(
    "fails closed for a directory junction reparse point",
    () => {
      const root = makeTempRoot();
      const target = resolve(root, "target-directory");
      const junction = resolve(root, "directory-junction");
      mkdirSync(target);

      expect(createLink(["/J", quoteForCmd(junction), quoteForCmd(target)])).toBe("created");

      expect(verifyWindowsOwnerPrivateAcl(junction)).toBe(false);
      expect(hardenWindowsOwnerPrivateAcl(junction, "directory")).toBe(false);
    },
  );

  it.skipIf(!isWindows || !canCreateSymbolicLink)(
    "fails closed for directory and file symbolic-link reparse points",
    () => {
      const root = makeTempRoot();
      const targetDirectory = resolve(root, "target-directory");
      const directoryLink = resolve(root, "directory-link");
      const targetFile = resolve(root, "target-file.json");
      const fileLink = resolve(root, "file-link.json");
      mkdirSync(targetDirectory);
      writeFileSync(targetFile, "{}\n", "utf8");

      expect(createLink([quoteForCmd(directoryLink), quoteForCmd(targetDirectory)])).toBe(
        "created",
      );
      expect(createLink([quoteForCmd(fileLink), quoteForCmd(targetFile)])).toBe("created");

      expect(verifyWindowsOwnerPrivateAcl(directoryLink)).toBe(false);
      expect(hardenWindowsOwnerPrivateAcl(directoryLink, "directory")).toBe(false);
      expect(verifyWindowsOwnerPrivateAcl(fileLink)).toBe(false);
      expect(hardenWindowsOwnerPrivateAcl(fileLink, "file")).toBe(false);
    },
  );
});

function makeTempRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-owner-private-acl-adversarial-"));
  roots.push(root);
  return root;
}

function runWindowsPowerShell(script: string, path: string): void {
  const result = spawnSync(
    systemPowerShellPath(),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: COMMAND_MAX_BUFFER_BYTES,
      env: { ...process.env, CROSSAGENT_ACL_TEST_PATH: path },
    },
  );
  if (result.status !== 0)
    throw new Error(`Unable to alter ACL for adversarial test (status ${result.status}).`);
}

function createLink(argumentsForMklink: string[]): "created" | "permission-denied" {
  const command = `mklink ${argumentsForMklink.join(" ")}`;
  const result = spawnSync(systemCmdPath(), ["/d", "/c", command], {
    encoding: "utf8",
    windowsHide: true,
    windowsVerbatimArguments: true,
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: COMMAND_MAX_BUFFER_BYTES,
  });
  if (result.status === 0) return "created";

  const message = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  if (isPermissionDenied(message)) return "permission-denied";
  throw new Error(`Unable to create reparse-point test fixture (status ${result.status}).`);
}

function canCreateTestLink(kind: "junction" | "symbolic-link"): boolean {
  const root = mkdtempSync(resolve(tmpdir(), "crossagent-owner-private-acl-link-probe-"));
  try {
    const target = resolve(root, "target");
    const link = resolve(root, "link");
    if (kind === "junction") {
      mkdirSync(target);
      return createLink(["/J", quoteForCmd(link), quoteForCmd(target)]) === "created";
    }

    writeFileSync(target, "probe\n", "utf8");
    return createLink([quoteForCmd(link), quoteForCmd(target)]) === "created";
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function systemPowerShellPath(): string {
  return resolveSystemExecutable("WindowsPowerShell", "v1.0", "powershell.exe");
}

function systemCmdPath(): string {
  return resolveSystemExecutable("cmd.exe");
}

function resolveSystemExecutable(...parts: string[]): string {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    throw new Error("SystemRoot is unavailable for a Windows-only test.");
  }
  return resolve(systemRoot, "System32", ...parts);
}

function quoteForCmd(path: string): string {
  return `"${path.replaceAll('"', '""')}"`;
}

function isPermissionDenied(message: string): boolean {
  return (
    message.includes("access is denied") ||
    message.includes("you do not have sufficient privilege") ||
    message.includes("privilege is not held") ||
    message.includes("does not have the privilege") ||
    message.includes("a required privilege is not held") ||
    message.includes("拒绝访问") ||
    message.includes("权限不足") ||
    message.includes("没有所需的特权")
  );
}
