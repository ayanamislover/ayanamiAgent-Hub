import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { spawn as spawnNodePty } from "node-pty";
import { createId, nowIso } from "@crossagent/protocol";
import { ForbiddenError, HubError, NotFoundError } from "../domain/errors.js";
import type { HubStore } from "./hub-store.js";

/**
 * Terminal sessions for the console.
 *
 * The user authorised arbitrary commands, so this deliberately does not filter what gets run.
 * The boundaries that remain are the ones that survive that decision:
 *   - a spawn requires a live `terminal.unrestricted` grant the user approved in the Dashboard,
 *   - attaching to a session's output requires that same grant, for the project that owns it,
 *   - every input and resize re-checks it, so revoking takes control of a live terminal away
 *     rather than only preventing new ones,
 *   - nothing executes that the user did not submit: the Hub never writes to a pty by itself,
 *   - output is bounded so a runaway process cannot grow the Hub's memory without limit, and the
 *     number of retained exited sessions is bounded for the same reason,
 *   - spawn, resize, exit, kill and errors are audited on the project event stream.
 *
 * Killing is deliberately *not* gated on the grant: revoking authorization must never leave the
 * user unable to stop a process that is already running. Revocation therefore takes away control
 * of a running process without terminating it — stopping it stays an explicit act.
 */

const MAX_BUFFERED_BYTES = 256 * 1024;
const MAX_SESSIONS_PER_PROJECT = 8;
/**
 * Exited sessions are kept so the user can still read what a process printed before it died, but
 * they cannot be kept forever: each one holds up to MAX_BUFFERED_BYTES of scrollback, and the live
 * cap above only counts running sessions, so nothing bounded total growth over a Hub's lifetime.
 */
const MAX_EXITED_SESSIONS_PER_PROJECT = 8;
/** Audit payloads land on the shared event stream, so failure text is clipped rather than raw. */
const MAX_AUDITED_ERROR_CHARS = 500;
/**
 * Directories to search beyond PATH, relative to the user's profile.
 *
 * Claude Code installs into `.local\bin` and does not necessarily put it on the PATH that a Hub
 * started from a shortcut or a service inherits. Without this the console's Claude panel fails while
 * the Codex one works, which reads as a bug in the page rather than a machine layout difference.
 */
const WINDOWS_EXTRA_BIN_DIRS = [".local\\bin"];
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export type PtySessionInfo = {
  id: string;
  projectId: string;
  label: string;
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  pid: number;
  startedAt: string;
  exitedAt: string | null;
  exitCode: number | null;
};

/**
 * The slice of node-pty this service actually uses. Declaring it separately lets tests drive the
 * full lifecycle without a native build or a real shell; `IPty` satisfies it structurally.
 */
export type PtyProcess = {
  readonly pid: number;
  onData(listener: (chunk: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
};

export type PtySpawner = (
  shell: string,
  args: string[],
  options: {
    name: string;
    cols: number;
    rows: number;
    cwd: string;
    env: Record<string, string>;
  },
) => PtyProcess;

const defaultSpawner: PtySpawner = (shell, args, options) => spawnNodePty(shell, args, options);

type Session = PtySessionInfo & {
  pty: PtyProcess | null;
  /** Replayed to a client that attaches after output has already been produced. */
  buffer: string;
  bufferedBytes: number;
  listeners: Set<(chunk: string) => void>;
  exitListeners: Set<(code: number) => void>;
};

export class PtyService {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly store: HubStore,
    private readonly spawnProcess: PtySpawner = defaultSpawner,
  ) {}

  list(projectId: string): PtySessionInfo[] {
    return [...this.sessions.values()]
      .filter((session) => session.projectId === projectId)
      .map(toInfo);
  }

  get(id: string): Session {
    const session = this.sessions.get(id);
    if (!session) throw new NotFoundError("Terminal session", id);
    return session;
  }

  spawn(input: {
    projectId: string;
    label: string;
    shell: string;
    args?: string[];
    cwd: string;
    cols?: number;
    rows?: number;
    requestedByAgentId: string;
  }): PtySessionInfo {
    const grant = this.requireGrant(input.projectId);
    const live = [...this.sessions.values()].filter(
      (session) => session.projectId === input.projectId && !session.exitedAt,
    );
    if (live.length >= MAX_SESSIONS_PER_PROJECT) {
      throw new ForbiddenError(
        `This project already has ${MAX_SESSIONS_PER_PROJECT} live terminal sessions`,
      );
    }

    const id = createId("pty");
    const cols = input.cols ?? 120;
    const rows = input.rows ?? 30;
    const args = input.args ?? [];

    const shell = resolveExecutable(input.shell);

    let pty: PtyProcess;
    try {
      pty = this.spawnProcess(shell, args, {
        name: "xterm-256color",
        cols,
        rows,
        cwd: input.cwd,
        // `name` above tells the pty what it is; the child reads TERM, and inheriting the Hub's own
        // TERM overrode it. A Hub started from a service or a shortcut carries TERM=dumb, which made
        // Codex warn that its interactive TUI may not work and render an unusable transcript, so the
        // terminal the client actually gets has to be declared here too.
        env: { ...(process.env as Record<string, string>), TERM: "xterm-256color" },
      });
    } catch (error) {
      // A shell that does not exist is the most common way this fails, and it happens before
      // there is a session to hang the audit off — so record it against the id we reserved.
      this.recordError(input.projectId, id, "spawn", error);
      throw error;
    }

    const session: Session = {
      id,
      projectId: input.projectId,
      label: input.label,
      // The resolved path, not what was asked for: the audit trail should say what actually ran.
      shell,
      args,
      cwd: input.cwd,
      cols,
      rows,
      pid: pty.pid,
      startedAt: nowIso(),
      exitedAt: null,
      exitCode: null,
      pty,
      buffer: "",
      bufferedBytes: 0,
      listeners: new Set(),
      exitListeners: new Set(),
    };
    this.sessions.set(id, session);

    pty.onData((chunk) => {
      session.buffer += chunk;
      session.bufferedBytes += Buffer.byteLength(chunk);
      while (session.bufferedBytes > MAX_BUFFERED_BYTES && session.buffer.length > 0) {
        const drop = Math.ceil(session.buffer.length / 4);
        session.bufferedBytes -= Buffer.byteLength(session.buffer.slice(0, drop));
        session.buffer = session.buffer.slice(drop);
      }
      for (const listener of session.listeners) listener(chunk);
    });

    pty.onExit(({ exitCode }) => {
      session.pty = null;
      session.exitedAt = nowIso();
      session.exitCode = exitCode;
      for (const listener of session.exitListeners) listener(exitCode);
      this.audit(session, "terminal.exited", { exitCode });
      this.pruneExitedSessions(session.projectId);
    });

    this.audit(session, "terminal.spawned", {
      shell: session.shell,
      args: session.args,
      cwd: session.cwd,
      pid: session.pid,
      requestedBy: input.requestedByAgentId,
      grantId: grant?.id ?? null,
    });
    return toInfo(session);
  }

  /** Only ever called from a client frame: the Hub never originates terminal input. */
  write(id: string, data: string): void {
    const session = this.get(id);
    // Re-checked on every frame rather than once at attach. Checking only at attach meant a
    // socket that connected while the grant was live kept accepting arbitrary commands after the
    // user revoked it, so "revoke at any time" silently meant "revoke for new sessions only".
    this.requireGrant(session.projectId);
    if (!session.pty) throw new ForbiddenError("Terminal session has already exited");
    try {
      session.pty.write(data);
    } catch (error) {
      // The input itself is the user's own keystrokes, so it is never audited — only the failure.
      this.recordError(session.projectId, session.id, "write", error);
      throw error;
    }
  }

  resize(id: string, cols: number, rows: number): void {
    const session = this.get(id);
    // Gated ahead of the no-op check below: whether the grant still holds must not depend on
    // whether the requested dimensions happen to match the current ones.
    this.requireGrant(session.projectId);
    // A terminal emitting an audit event per pixel of a window drag would drown the event
    // stream, so a resize to the size it already has is a no-op rather than a record.
    if (session.cols === cols && session.rows === rows) return;
    session.cols = cols;
    session.rows = rows;
    try {
      session.pty?.resize(cols, rows);
    } catch (error) {
      this.recordError(session.projectId, session.id, "resize", error);
      throw error;
    }
    this.audit(session, "terminal.resized", { cols, rows });
  }

  kill(id: string): void {
    const session = this.get(id);
    if (!session.pty) return;
    try {
      session.pty.kill();
    } catch (error) {
      this.recordError(session.projectId, session.id, "kill", error);
      throw error;
    }
    this.audit(session, "terminal.killed", { pid: session.pid });
  }

  /**
   * Attaching starts a live output stream, so it is gated exactly like spawning: the caller has
   * to name the project, the session has to belong to it, and that project's grant has to still
   * be live. Without the project argument any authenticated socket could stream any session.
   */
  attach(
    projectId: string,
    id: string,
    onData: (chunk: string) => void,
    onExit: (code: number) => void,
  ): { detach: () => void; backlog: string } {
    this.requireGrant(projectId);
    const session = this.get(id);
    if (session.projectId !== projectId) {
      // Deliberately the same error a missing session produces: whether an id exists in another
      // project is not something this endpoint should confirm.
      throw new NotFoundError("Terminal session", id);
    }
    session.listeners.add(onData);
    session.exitListeners.add(onExit);
    return {
      backlog: session.buffer,
      detach: () => {
        session.listeners.delete(onData);
        session.exitListeners.delete(onExit);
      },
    };
  }

  disposeAll(): void {
    for (const session of this.sessions.values()) session.pty?.kill();
    this.sessions.clear();
  }

  /**
   * Drops the oldest exited sessions once a project has more than it can justify keeping. Ordered
   * by when each one exited rather than when it started: the interesting scrollback is the one that
   * died most recently, and two sessions can exit in a different order than they were spawned.
   */
  private pruneExitedSessions(projectId: string): void {
    const exited: { id: string; exitedAt: string }[] = [];
    for (const candidate of this.sessions.values()) {
      if (candidate.projectId === projectId && candidate.exitedAt) {
        exited.push({ id: candidate.id, exitedAt: candidate.exitedAt });
      }
    }
    if (exited.length <= MAX_EXITED_SESSIONS_PER_PROJECT) return;
    exited.sort((left, right) => left.exitedAt.localeCompare(right.exitedAt));
    for (const victim of exited.slice(0, exited.length - MAX_EXITED_SESSIONS_PER_PROJECT)) {
      this.sessions.delete(victim.id);
    }
  }

  private requireGrant(projectId: string) {
    const { allowed, grant } = this.store.checkAuthorization(projectId, "terminal.unrestricted");
    if (allowed) return grant;
    // checkAuthorization only reports a live grant, so fall back to the most recent decision to
    // tell the user what actually happened: "never requested" and "you revoked it" are
    // different problems with different fixes.
    const last = grant ?? this.store.listAuthorizations(projectId)[0];
    // Its own code, not a bare FORBIDDEN: a socket that is already attached has to be able to
    // tell "your authorization is gone, drop the attachment" apart from any other 403.
    throw new HubError(
      last
        ? `Terminal authorization is ${last.status}; approve it in the Dashboard before spawning a session`
        : "No terminal authorization has been requested for this project",
      403,
      "TERMINAL_NOT_AUTHORIZED",
    );
  }

  private audit(session: Session, type: string, payload: Record<string, unknown>): void {
    this.store.recordTerminalEvent(session.projectId, {
      type,
      sessionId: session.id,
      payload,
    });
  }

  private recordError(
    projectId: string,
    sessionId: string,
    operation: string,
    error: unknown,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    this.store.recordTerminalEvent(projectId, {
      type: "terminal.error",
      sessionId,
      payload: { operation, message: message.slice(0, MAX_AUDITED_ERROR_CHARS) },
    });
  }
}

/**
 * Turns a bare command name into something Windows can actually start.
 *
 * node-pty spawns through CreateProcess, which does not apply PATHEXT: asking for `codex` fails with
 * an empty `File not found:` while `codex.exe` starts normally. Clients therefore could not launch an
 * agent by name at all, which is how both console launch buttons came to be dead on Windows. Resolving
 * here rather than in each client keeps machine layout out of the UI — a page should be able to say
 * "codex" and mean it.
 *
 * Anything already carrying a path separator is left alone: a caller that named a location has made a
 * decision this should not second-guess. An unresolvable name is also returned untouched, so the
 * failure comes from the spawn itself with its own message rather than from a guess made here.
 */
function resolveExecutable(shell: string): string {
  if (process.platform !== "win32") return shell;
  if (shell.includes("/") || shell.includes("\\")) return shell;
  const extensions = (process.env.PATHEXT ?? DEFAULT_PATHEXT).split(";").filter(Boolean);
  const profile = process.env.USERPROFILE;
  const directories = [
    ...(process.env.PATH ?? "").split(";").filter(Boolean),
    ...(profile ? WINDOWS_EXTRA_BIN_DIRS.map((relative) => resolvePath(profile, relative)) : []),
  ];
  const named = extensions.some((extension) =>
    shell.toLowerCase().endsWith(extension.toLowerCase()),
  );
  const candidates = named ? [shell] : extensions.map((extension) => `${shell}${extension}`);
  for (const directory of directories) {
    for (const candidate of candidates) {
      const full = resolvePath(directory, candidate);
      if (existsSync(full)) return full;
    }
  }
  return shell;
}

function toInfo(session: Session): PtySessionInfo {
  const { pty: _pty, buffer: _buffer, listeners: _l, exitListeners: _e, ...info } = session;
  void _pty;
  void _buffer;
  void _l;
  void _e;
  return info as PtySessionInfo;
}
