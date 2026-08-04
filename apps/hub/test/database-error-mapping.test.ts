import { describe, expect, it } from "vitest";
import { hubErrorFromDatabase } from "../src/domain/errors.js";

function sqliteError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe("database refusals at the HTTP boundary", () => {
  it("answers a fence abort with a 409 and a code derived from the fence", () => {
    const mapped = hubErrorFromDatabase(
      sqliteError("SQLITE_CONSTRAINT_TRIGGER", "live session fence: invalid head_run identity"),
    );

    // 409, not 500. The distinction is the entire point: a 500 reads as transient, so a permanent
    // refusal presented as a retryable one and at least one client retried it indefinitely instead
    // of changing what it asked for.
    expect(mapped).toMatchObject({
      statusCode: 409,
      code: "LIVE_SESSION_FENCE_INVALID_HEAD_RUN_IDENTITY",
      message: "live session fence: invalid head_run identity",
    });
  });

  it("gives each fence its own code so a caller can branch on which invariant refused", () => {
    const identity = hubErrorFromDatabase(
      sqliteError("SQLITE_CONSTRAINT_TRIGGER", "live session fence: invalid head_run identity"),
    );
    const generation = hubErrorFromDatabase(
      sqliteError("SQLITE_CONSTRAINT_TRIGGER", "live session fence: invalid head_run_generation"),
    );

    expect(identity?.code).not.toBe(generation?.code);
    expect(generation?.code).toBe("LIVE_SESSION_FENCE_INVALID_HEAD_RUN_GENERATION");
  });

  it("leaves a constraint failure it does not author as an internal fault", () => {
    // Deliberate. A uniqueness violation we did not anticipate, or a trigger firing where we
    // expected none, is a fault on this side: the caller could not have asked for anything
    // different, so calling it a 409 would blame them for our bug. Only invariants we wrote and
    // documented get to refuse a caller by name.
    expect(
      hubErrorFromDatabase(
        sqliteError("SQLITE_CONSTRAINT_UNIQUE", "UNIQUE constraint failed: agent_sessions.pid"),
      ),
    ).toBeNull();
    expect(
      hubErrorFromDatabase(
        sqliteError("SQLITE_CONSTRAINT_TRIGGER", "injected in-flight recipient rebind failure"),
      ),
    ).toBeNull();
  });

  it("leaves anything that is not a constraint failure alone", () => {
    expect(hubErrorFromDatabase(sqliteError("SQLITE_BUSY", "database is locked"))).toBeNull();
    expect(hubErrorFromDatabase(new Error("boom"))).toBeNull();
    expect(hubErrorFromDatabase("not an error")).toBeNull();
  });
});
