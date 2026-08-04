import { describe, expect, it } from "vitest";
import {
  TERMINAL_INPUT_CHUNK_SIZE,
  chunkTerminalInput,
  clampTerminalSize,
  parseTerminalServerFrame,
  terminalSocketUrl,
} from "./console-contract.js";

describe("terminal console contracts", () => {
  it("clamps fit-addon dimensions to the Hub frame bounds", () => {
    expect(clampTerminalSize(8, 2)).toEqual({ cols: 20, rows: 5 });
    expect(clampTerminalSize(120.8, 30.9)).toEqual({ cols: 120, rows: 30 });
    expect(clampTerminalSize(900, 400)).toEqual({ cols: 500, rows: 200 });
  });

  it("chunks a large paste below the Hub limit without splitting a surrogate pair", () => {
    const input = `${"a".repeat(TERMINAL_INPUT_CHUNK_SIZE - 1)}😀${"b".repeat(9_000)}`;
    const chunks = chunkTerminalInput(input);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= TERMINAL_INPUT_CHUNK_SIZE)).toBe(true);
    expect(chunks.join("")).toBe(input);
    expect(chunks.some((chunk) => chunk.endsWith("\ud83d"))).toBe(false);
  });

  it("uses a same-origin WebSocket URL", () => {
    expect(terminalSocketUrl({ protocol: "http:", host: "127.0.0.1:4387" } as Location)).toBe(
      "ws://127.0.0.1:4387/ws/terminal",
    );
    expect(terminalSocketUrl({ protocol: "https:", host: "hub.test" } as Location)).toBe(
      "wss://hub.test/ws/terminal",
    );
  });

  it("parses only declared Hub frames", () => {
    expect(
      parseTerminalServerFrame(
        JSON.stringify({ type: "attached", sessionId: "ses_1234", backlog: "ready" }),
      ),
    ).toEqual({ type: "attached", sessionId: "ses_1234", backlog: "ready" });
    expect(parseTerminalServerFrame(JSON.stringify({ type: "exit", exitCode: "0" }))).toBeNull();
    expect(parseTerminalServerFrame(JSON.stringify({ type: "mystery" }))).toBeNull();
    expect(parseTerminalServerFrame("not json")).toBeNull();
  });
});
