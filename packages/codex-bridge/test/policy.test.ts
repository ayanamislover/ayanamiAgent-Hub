import { describe, expect, it } from "vitest";
import { compactCodexEvent } from "../src/bridge.js";

describe("compactCodexEvent", () => {
  it("keeps injected text bounded and action-oriented", () => {
    const text = compactCodexEvent({
      id: "msg_1234",
      projectId: "prj_1234",
      sequence: 1,
      threadId: "thr_1234",
      replyTo: null,
      taskId: null,
      reviewId: null,
      fromAgentId: "claude",
      fromSessionId: null,
      type: "PROPOSAL",
      priority: "IMPORTANT",
      requiresAck: true,
      requiresResponse: false,
      summary: "Public API shape changes.",
      detail: null,
      references: [],
      dedupeKey: null,
      expiresAt: null,
      createdAt: new Date().toISOString(),
      recipients: [],
    });
    expect(text).toContain('priority="IMPORTANT"');
    expect(text).toContain('thread_id="thr_1234"');
    expect(text).not.toContain("undefined");
    expect(text.length).toBeLessThan(700);
  });
});
