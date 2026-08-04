import {
  TERMINAL_SIZE_BOUNDS,
  TerminalServerFrameSchema,
  type TerminalServerFrame,
  type TerminalSize,
} from "@crossagent/protocol/terminal";

export const TERMINAL_INPUT_CHUNK_SIZE = 8_000;

export type { TerminalSize };

export function clampTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: Math.min(
      TERMINAL_SIZE_BOUNDS.cols.max,
      Math.max(TERMINAL_SIZE_BOUNDS.cols.min, Math.trunc(cols)),
    ),
    rows: Math.min(
      TERMINAL_SIZE_BOUNDS.rows.max,
      Math.max(TERMINAL_SIZE_BOUNDS.rows.min, Math.trunc(rows)),
    ),
  };
}

/**
 * The Hub rejects an input frame above 8 KiB as a whole. Keep a little room below that contract
 * and avoid splitting a UTF-16 surrogate pair so a large paste remains ordered and intact.
 */
export function chunkTerminalInput(data: string): string[] {
  const chunks: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    let end = Math.min(data.length, offset + TERMINAL_INPUT_CHUNK_SIZE);
    if (end < data.length) {
      const finalCodeUnit = data.charCodeAt(end - 1);
      if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
    }
    chunks.push(data.slice(offset, end));
    offset = end;
  }
  return chunks;
}

export function terminalSocketUrl(location: Pick<Location, "protocol" | "host">): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${location.host}/ws/terminal`;
}

export function parseTerminalServerFrame(data: string): TerminalServerFrame | null {
  try {
    const parsed = TerminalServerFrameSchema.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
