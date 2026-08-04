import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const ACL_COMMAND_TIMEOUT_MS = 10_000;
const ACL_COMMAND_MAX_BUFFER_BYTES = 4 * 1024;
const VERIFIED_MARKER = "CROSSAGENT_OWNER_PRIVATE_V1";

const VERIFY_OWNER_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$literalPath = [string]$env:CROSSAGENT_ACL_LITERAL_PATH
$attributes = [System.IO.File]::GetAttributes($literalPath)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 21 }
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
$sections = [System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner
$acl = if ($isDirectory) {
  [System.IO.Directory]::GetAccessControl($literalPath, $sections)
} else {
  [System.IO.File]::GetAccessControl($literalPath, $sections)
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$administratorSid = 'S-1-5-32-544'
$systemSid = 'S-1-5-18'
$ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if ($ownerSid -ne $currentSid -and $ownerSid -ne $administratorSid) { exit 22 }
$currentHasFullControl = $false
foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  $ruleSid = $rule.IdentityReference.Value
  if ($ruleSid -ne $currentSid -and $ruleSid -ne $administratorSid -and $ruleSid -ne $systemSid) { exit 23 }
  if ($ruleSid -eq $currentSid -and (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl)) {
    $currentHasFullControl = $true
  }
}
if (-not $currentHasFullControl) { exit 24 }
[Console]::Out.Write('${VERIFIED_MARKER}')
`;

const HARDEN_OWNER_PRIVATE_ACL = String.raw`
$ErrorActionPreference = 'Stop'
$literalPath = [string]$env:CROSSAGENT_ACL_LITERAL_PATH
$expectedKind = [string]$env:CROSSAGENT_ACL_PATH_KIND
$attributes = [System.IO.File]::GetAttributes($literalPath)
if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { exit 31 }
$isDirectory = ($attributes -band [System.IO.FileAttributes]::Directory) -ne 0
if (($expectedKind -eq 'directory') -ne $isDirectory) { exit 32 }
$acl = if ($isDirectory) {
  [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  [System.Security.AccessControl.FileSecurity]::new()
}
$currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl.SetOwner($currentIdentity)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($isDirectory) {
  [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
} else {
  [System.Security.AccessControl.InheritanceFlags]::None
}
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$fullControl = [System.Security.AccessControl.FileSystemRights]::FullControl
$identities = @(
  $currentIdentity,
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'),
  [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
)
foreach ($identity in $identities) {
  $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, $fullControl, $inheritance, $propagation, $allow)
  [void]$acl.AddAccessRule($rule)
}
if ($isDirectory) {
  [System.IO.Directory]::SetAccessControl($literalPath, $acl)
} else {
  [System.IO.File]::SetAccessControl($literalPath, $acl)
}
`;

export type WindowsOwnerPrivateAclPathKind = "directory" | "file";

/**
 * Applies an explicit Windows DACL containing only the current principal, LocalSystem, and the
 * built-in Administrators group. This is an OS authorization seam; it never treats chmod as a
 * Windows ACL substitute and never uses WMI/CIM.
 */
export function hardenWindowsOwnerPrivateAcl(
  path: string,
  kind: WindowsOwnerPrivateAclPathKind,
): boolean {
  if (process.platform !== "win32" || !exactPathKind(path, kind)) return false;
  const result = runWindowsPowerShell(HARDEN_OWNER_PRIVATE_ACL, resolve(path), kind);
  return result.status === 0 && verifyWindowsOwnerPrivateAcl(path);
}

/** Read-only verification for a path previously hardened by the installer/runtime. */
export function verifyWindowsOwnerPrivateAcl(path: string): boolean {
  if (process.platform !== "win32" || !exactPathKind(path)) return false;
  const result = runWindowsPowerShell(VERIFY_OWNER_PRIVATE_ACL, resolve(path));
  return result.status === 0 && result.stdout.trim() === VERIFIED_MARKER;
}

function exactPathKind(path: string, expected?: WindowsOwnerPrivateAclPathKind): boolean {
  try {
    const metadata = lstatSync(resolve(path));
    if (metadata.isSymbolicLink()) return false;
    if (expected === "directory") return metadata.isDirectory();
    if (expected === "file") return metadata.isFile();
    return metadata.isDirectory() || metadata.isFile();
  } catch {
    return false;
  }
}

function runWindowsPowerShell(
  script: string,
  literalPath: string,
  kind?: WindowsOwnerPrivateAclPathKind,
) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !isAbsolute(systemRoot)) {
    return { status: null, stdout: "", stderr: "SystemRoot is unavailable" };
  }
  const executable = resolve(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    const metadata = lstatSync(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      return { status: null, stdout: "", stderr: "PowerShell executable is unavailable" };
    }
  } catch {
    return { status: null, stdout: "", stderr: "PowerShell executable is unavailable" };
  }
  const result = spawnSync(
    executable,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: ACL_COMMAND_TIMEOUT_MS,
      maxBuffer: ACL_COMMAND_MAX_BUFFER_BYTES,
      env: {
        ...process.env,
        CROSSAGENT_ACL_LITERAL_PATH: literalPath,
        ...(kind ? { CROSSAGENT_ACL_PATH_KIND: kind } : {}),
      },
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
