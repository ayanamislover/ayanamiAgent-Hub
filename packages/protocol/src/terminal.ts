import { z } from "zod";

export const TERMINAL_SIZE_BOUNDS = {
  cols: { min: 20, max: 500 },
  rows: { min: 5, max: 200 },
} as const;

export const TERMINAL_MAX_INPUT_CHARS = 8 * 1024;

export const TerminalSizeSchema = z.object({
  cols: z.number().int().min(TERMINAL_SIZE_BOUNDS.cols.min).max(TERMINAL_SIZE_BOUNDS.cols.max),
  rows: z.number().int().min(TERMINAL_SIZE_BOUNDS.rows.min).max(TERMINAL_SIZE_BOUNDS.rows.max),
});
export type TerminalSize = z.infer<typeof TerminalSizeSchema>;

export const TerminalClientFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attach"),
    projectId: z.string().min(4).max(100),
    sessionId: z.string().min(4).max(100),
  }),
  z.object({
    type: z.literal("input"),
    data: z.string().max(TERMINAL_MAX_INPUT_CHARS),
  }),
  TerminalSizeSchema.extend({ type: z.literal("resize") }),
]);
export type TerminalClientFrame = z.infer<typeof TerminalClientFrameSchema>;

export const TerminalServerFrameSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attached"),
    sessionId: z.string().min(4).max(100),
    backlog: z.string(),
  }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exit"), exitCode: z.number().int() }),
  z.object({
    type: z.literal("unauthorized"),
    projectId: z.string().min(4).max(100).nullable(),
    message: z.string(),
  }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type TerminalServerFrame = z.infer<typeof TerminalServerFrameSchema>;
