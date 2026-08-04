import { describe, expect, it } from "vitest";
import {
  AuthorityTypeSchema,
  CaptureUserTurnInputSchema,
  CredentialScopeSchema,
  DirectiveLifecycleSchema,
} from "../src/index.js";

describe("authority protocol", () => {
  it("exposes the complete authority and directive lifecycle vocabularies", () => {
    expect(AuthorityTypeSchema.options).toEqual([
      "USER_DIRECT",
      "USER_ATTESTED",
      "USER_DELEGATED",
      "AGENT_DECISION",
      "AGENT_PROPOSAL",
      "AGENT_HEARSAY",
    ]);
    expect(DirectiveLifecycleSchema.options).toEqual([
      "ACTIVE",
      "SUPERSEDED",
      "REVOKED",
      "COMPLETED",
      "EXPIRED",
    ]);
  });

  it("keeps bootstrap enrollment and dynamic ticket scopes explicit", () => {
    expect(CredentialScopeSchema.options).toEqual([
      "hub:agent",
      "hub:dashboard",
      "project:select",
      "project:join",
      "session-ticket:offer",
      "session-ticket:offer:capture",
      "session-ticket:offer:injector",
      "session:enroll:first",
      "hub:session",
      "hub:mcp",
      "user_turn:capture",
      "synthetic_prompt:reserve",
      "directive:relay",
    ]);
  });

  it("preserves the exact raw prompt without trimming or normalization", () => {
    const raw = "  first line\r\nemoji: \ud83e\udd16\u0000tail  ";
    const parsed = CaptureUserTurnInputSchema.parse({
      user_turn_id: "utr_fixture",
      project_id: "prj_fixture",
      client_type: "codex",
      session_id: "desktop-session",
      turn_id: "turn-1",
      cwd: "R:\\fixture",
      raw_prompt: raw,
      captured_at: "2026-07-31T10:00:00.000Z",
      idempotency_key: "capture:fixture",
    });
    expect(parsed.raw_prompt).toBe(raw);
  });

  it("rejects lone high and low surrogates instead of hashing both as replacement bytes", () => {
    const input = {
      user_turn_id: "utr_fixture",
      project_id: "prj_fixture",
      client_type: "codex",
      session_id: "desktop-session",
      turn_id: "turn-1",
      cwd: "R:\\fixture",
      captured_at: "2026-07-31T10:00:00.000Z",
      idempotency_key: "capture:fixture",
    } as const;

    expect(() => CaptureUserTurnInputSchema.parse({ ...input, raw_prompt: "\ud800" })).toThrow(
      /unpaired surrogate/,
    );
    expect(() => CaptureUserTurnInputSchema.parse({ ...input, raw_prompt: "\udc00" })).toThrow(
      /unpaired surrogate/,
    );
    expect(() =>
      CaptureUserTurnInputSchema.parse({ ...input, raw_prompt: "\ud83e\udd16" }),
    ).not.toThrow();
  });
});
