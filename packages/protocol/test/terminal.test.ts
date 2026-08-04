import { describe, expect, it } from "vitest";
import {
  TERMINAL_MAX_INPUT_CHARS,
  TerminalClientFrameSchema,
  TerminalServerFrameSchema,
  TerminalSizeSchema,
} from "../src/index.js";

describe("terminal transport contract", () => {
  it("shares the spawn and resize bounds", () => {
    expect(TerminalSizeSchema.safeParse({ cols: 20, rows: 5 }).success).toBe(true);
    expect(TerminalSizeSchema.safeParse({ cols: 500, rows: 200 }).success).toBe(true);
    expect(TerminalSizeSchema.safeParse({ cols: 19, rows: 5 }).success).toBe(false);
    expect(TerminalSizeSchema.safeParse({ cols: 20, rows: 201 }).success).toBe(false);
  });

  it("rejects oversized or malformed client frames", () => {
    expect(
      TerminalClientFrameSchema.safeParse({
        type: "input",
        data: "x".repeat(TERMINAL_MAX_INPUT_CHARS),
      }).success,
    ).toBe(true);
    expect(
      TerminalClientFrameSchema.safeParse({
        type: "input",
        data: "x".repeat(TERMINAL_MAX_INPUT_CHARS + 1),
      }).success,
    ).toBe(false);
    expect(
      TerminalClientFrameSchema.safeParse({
        type: "attach",
        projectId: "prj_1234",
      }).success,
    ).toBe(false);
  });

  it("accepts only declared server frames", () => {
    expect(
      TerminalServerFrameSchema.safeParse({
        type: "attached",
        sessionId: "ses_1234",
        backlog: "ready",
      }).success,
    ).toBe(true);
    expect(
      TerminalServerFrameSchema.safeParse({
        type: "exit",
        exitCode: "0",
      }).success,
    ).toBe(false);
    expect(TerminalServerFrameSchema.safeParse({ type: "mystery" }).success).toBe(false);
  });
});
