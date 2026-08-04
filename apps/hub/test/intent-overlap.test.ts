import { describe, expect, it } from "vitest";
import { detectIntentOverlap } from "../src/git/git-service.js";

/**
 * These cases come from a false conflict observed in production, not from reading the code.
 *
 * Two exclusive intents were reported as a critical conflict with an empty file list: one matched 19
 * tracked files across apps/hub/package.json, apps/docs-site, apps/dashboard, packages and scripts,
 * the other matched 3 under apps/hub/src/services. Their exact intersection was empty. The only
 * thing they shared was the "apps" top-level directory, and in a monorepo where everything lives
 * under apps/ or packages/ that is true of almost any pair of intents -- so almost any two exclusive
 * intents collided critically, which trained both agents to treat conflicts as noise.
 */
const intent = (globs: string[], mode: "advisory" | "exclusive", symbols: string[] = []) =>
  ({ globs, symbols, mode }) as Parameters<typeof detectIntentOverlap>[0];

const tracked = [
  "apps/hub/package.json",
  "apps/hub/src/services/hub-store.ts",
  "apps/hub/src/services/store/context.ts",
  "apps/hub/test/hub.integration.test.ts",
  "apps/dashboard/package.json",
  "packages/cli/src/bin.ts",
  "scripts/repository-hygiene.mjs",
];

describe("detectIntentOverlap", () => {
  it("does not escalate two exclusive intents that share only a top-level directory", () => {
    const codexHygiene = intent(
      ["apps/hub/package.json", "apps/dashboard/package.json", "scripts/**"],
      "exclusive",
    );
    const claudeStore = intent(
      ["apps/hub/src/services/hub-store.ts", "apps/hub/src/services/store/**"],
      "exclusive",
    );

    const overlap = detectIntentOverlap(codexHygiene, claudeStore, tracked, []);

    // They genuinely both have work under apps/, so reporting something is defensible; reporting
    // `critical` is not. The distinction that matters is that the report can now name what is
    // actually shared. Previously this returned critical with `files: []` -- a critical conflict
    // unable to name one contested file. It now returns the directory it means.
    expect(overlap?.severity).toBe("medium");
    expect(overlap?.reason).toBe("Both intents touch the same top-level directory");
    expect(overlap?.files).toEqual(["apps/**"]);
  });

  it("still escalates two exclusive intents that contest the same file", () => {
    const left = intent(["apps/hub/src/services/hub-store.ts"], "exclusive");
    const right = intent(["apps/hub/src/services/**"], "exclusive");

    const overlap = detectIntentOverlap(left, right, tracked, []);

    expect(overlap?.severity).toBe("critical");
    expect(overlap?.reason).toBe("Two exclusive write intents overlap");
    expect(overlap?.files).toContain("apps/hub/src/services/hub-store.ts");
  });

  it("still escalates a protected-scope overlap regardless of mode", () => {
    const left = intent(["apps/hub/src/services/hub-store.ts"], "advisory");
    const right = intent(["apps/hub/src/services/**"], "advisory");

    const overlap = detectIntentOverlap(left, right, tracked, [
      "apps/hub/src/services/hub-store.ts",
    ]);

    expect(overlap?.severity).toBe("critical");
    expect(overlap?.reason).toContain("Protected scope overlaps");
  });

  it("escalates a symbol overlap between exclusive intents", () => {
    const left = intent(["apps/hub/src/services/**"], "exclusive", ["HubStore"]);
    const right = intent(["packages/cli/**"], "exclusive", ["HubStore"]);

    const overlap = detectIntentOverlap(left, right, tracked, []);

    expect(overlap?.severity).toBe("critical");
    expect(overlap?.symbols).toEqual(["HubStore"]);
  });

  it("reports nothing when the intents share no file, symbol or directory", () => {
    const left = intent(["apps/dashboard/**"], "exclusive");
    const right = intent(["packages/cli/**"], "exclusive");

    expect(detectIntentOverlap(left, right, tracked, [])).toBeNull();
  });
});
