import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  hardenWindowsOwnerPrivateAcl,
  verifyWindowsOwnerPrivateAcl,
} from "../src/windows-owner-private-acl.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows owner-private ACL", () => {
  it.runIf(process.platform === "win32")(
    "hardens and verifies exact directory and file paths without following reparse points",
    () => {
      const root = mkdtempSync(resolve(tmpdir(), "crossagent-owner-private-acl-"));
      roots.push(root);
      const file = resolve(root, "control.json");
      writeFileSync(file, "{}\n", "utf8");

      expect(hardenWindowsOwnerPrivateAcl(root, "directory")).toBe(true);
      expect(verifyWindowsOwnerPrivateAcl(root)).toBe(true);
      expect(hardenWindowsOwnerPrivateAcl(file, "file")).toBe(true);
      expect(verifyWindowsOwnerPrivateAcl(file)).toBe(true);
      expect(hardenWindowsOwnerPrivateAcl(file, "directory")).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")("fails closed outside Windows", () => {
    const root = mkdtempSync(resolve(tmpdir(), "crossagent-owner-private-acl-"));
    roots.push(root);
    expect(hardenWindowsOwnerPrivateAcl(root, "directory")).toBe(false);
    expect(verifyWindowsOwnerPrivateAcl(root)).toBe(false);
  });
});
