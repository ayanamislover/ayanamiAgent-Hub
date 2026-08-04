import { describe, expect, it } from "vitest";
import {
  DirectiveAttestationPayloadSchema,
  RelayUserDirectiveInputSchema,
  canonicalJson,
  canonicalStringSet,
} from "../src/directive-attestation.js";

describe("directive attestation protocol", () => {
  it("canonicalizes strict integer JSON with UTF-16 object-key ordering", () => {
    expect(canonicalJson({ z: [3, true, null], a: { b: "😀", a: "line\r\n" }, aa: 0 })).toBe(
      '{"a":{"a":"line\\r\\n","b":"😀"},"aa":0,"z":[3,true,null]}',
    );
    expect(canonicalStringSet(["claude", "codex", "claude"])).toEqual(["claude", "codex"]);
  });

  it.each([
    ["float", { value: 1.5 }],
    ["negative zero", { value: -0 }],
    ["undefined", { value: undefined }],
    ["date", { value: new Date() }],
    ["unpaired high surrogate", { value: "\ud800" }],
    ["unpaired low surrogate", { value: "\udc00" }],
  ])("rejects %s from signed canonical JSON", (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(/Canonical JSON rejects|safe non-negative-zero/);
  });

  it("requires the public relay contract and keeps interpretation separate", () => {
    const parsed = RelayUserDirectiveInputSchema.parse({
      source_user_turn_id: "utr_source",
      target_agent_ids: ["claude"],
      verbatim_text: "Please review apps/hub.",
      quote_start: 0,
      quote_end: 23,
      agent_interpretation: "I suggest reviewing the security boundary first.",
      objective_id: null,
      task_ids: [],
      file_globs: ["apps/hub/**"],
      idempotency_key: "relay-1",
    });
    expect(parsed.verbatim_text).toBe("Please review apps/hub.");
    expect(parsed.agent_interpretation).toContain("suggest");
    expect(() =>
      RelayUserDirectiveInputSchema.parse({ ...parsed, verification: "VALID" }),
    ).toThrow();
  });

  it("rejects non-canonical signed sets and invalid authority/delegation combinations", () => {
    const payload = {
      type: "crossagent.user-directive-attestation.v2" as const,
      schema_version: 2 as const,
      directive_id: "dir_example",
      project_id: "prj_example",
      carrier_message_id: "msg_carrier",
      authority: "USER_ATTESTED" as const,
      source: {
        user_turn_id: "utr_example",
        client_type: "codex" as const,
        session_id: "desktop-session",
        turn_id: "turn-1",
        raw_user_turn_sha256: "a".repeat(64),
      },
      quote: {
        start_utf16: 1,
        end_utf16: 3,
        verbatim_text: "😀",
        verbatim_text_sha256: "b".repeat(64),
      },
      delegated_instruction: null,
      relay: { principal_id: "prn_agent_codex", agent_id: "codex" as const, session_id: null },
      audience: { target_agent_ids: ["claude" as const] },
      scope: { objective_id: null, task_ids: [], file_globs: [] },
      delegation: null,
      supersedes_directive_id: null,
      priority: "IMPORTANT" as const,
      server_sequence: 4,
      issued_at: "2026-08-01T00:00:00.000Z",
      expires_at: null,
      key_id: "ed25519:example-key",
      causation_id: "utr_example",
      correlation_id: "dir_example",
    };
    const parsed = DirectiveAttestationPayloadSchema.parse(payload);
    expect(parsed.quote?.verbatim_text).toBe("😀");
    expect(() =>
      DirectiveAttestationPayloadSchema.parse({
        ...payload,
        audience: { target_agent_ids: ["codex", "claude"] },
      }),
    ).toThrow(/sorted and unique/);
    expect(() =>
      DirectiveAttestationPayloadSchema.parse({
        ...payload,
        delegation: {
          grant_id: "grt_example",
          version: 1,
          delegator_agent_ids: ["codex"],
          target_agent_ids: ["claude"],
          allowed_actions: ["ASSIGN_TASK"],
          objective_ids: [],
          task_ids: [],
          file_globs: [],
          max_priority: "IMPORTANT",
          expires_at: "2026-08-02T00:00:00.000Z",
        },
      }),
    ).toThrow(/cannot reference/);
    expect(() =>
      DirectiveAttestationPayloadSchema.parse({
        ...payload,
        authority: "USER_DELEGATED",
        delegation: {
          grant_id: "grt_example",
          version: 1,
          delegator_agent_ids: ["codex"],
          target_agent_ids: ["claude"],
          allowed_actions: ["ASSIGN_TASK"],
          objective_ids: [],
          task_ids: [],
          file_globs: [],
          max_priority: "IMPORTANT",
          expires_at: "2026-08-02T00:00:00.000Z",
        },
        delegated_instruction: { text: "bounded task", text_sha256: "c".repeat(64) },
      }),
    ).toThrow(/cannot inherit a user-turn quote/);
  });
});
