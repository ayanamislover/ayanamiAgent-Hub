import { createHash, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  createOpaqueToken,
  type CredentialScope,
  type PrincipalKind,
  type SessionTicketPurpose,
  type SessionTicketState,
} from "@crossagent/protocol";
import type Database from "better-sqlite3";
import type { FastifyRequest } from "fastify";
import { ForbiddenError } from "../domain/errors.js";
import {
  findActiveSessionTicketById,
  findActiveSessionTicketsByDigest,
  findDormantCurrentHeadControlTicketsByDigest,
  findExpiredActiveControlTicketsByDigest,
  findPendingSessionTicketByDigest,
  findTerminalSessionTicketsByDigest,
  STATIC_ADAPTER_SCOPES,
  type SessionTicketAuthentication,
} from "./session-tickets.js";

export type RequestPrincipal = {
  id: string;
  credentialId: string;
  credentialClass: "STATIC" | "SESSION_TICKET";
  kind: PrincipalKind;
  displayName: string;
  scopes: CredentialScope[];
  projectId: string | null;
  clientType: "codex" | "claude" | null;
  hubSessionId: string | null;
  agentId: string | null;
  adapterClient: "codex" | "claude" | null;
  lineageId: string | null;
  incarnation: number | null;
  ticketPurpose: SessionTicketPurpose | null;
  ticketState: SessionTicketState | null;
  authenticatedVia:
    "authorization_bearer" | "x_crossagent_token" | "dashboard_cookie" | "bootstrap";
};

export type LoadedCredential = {
  token: string;
  path: string;
  principal: RequestPrincipal;
};

export type LocalCredentials = {
  /** Compatibility bearer for ordinary collaboration only; it cannot relay user authority. */
  agent: LoadedCredential;
  agentByClient: Record<"codex" | "claude", LoadedCredential>;
  dashboard: LoadedCredential;
  capture: Record<"codex" | "claude", LoadedCredential>;
  injector: Record<"codex" | "claude", LoadedCredential>;
};

type CredentialRow = {
  credential_id: string;
  principal_id: string;
  kind: PrincipalKind;
  display_name: string;
  project_id: string | null;
  client_type: "codex" | "claude" | null;
  scopes_json: string;
};

type PresentedCredential = {
  token: string;
  via: Exclude<RequestPrincipal["authenticatedVia"], "bootstrap">;
};

const requestPrincipals = new WeakMap<object, RequestPrincipal>();

function tokenSha256(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function loadOrCreateCredentialFile(
  dataDir: string,
  filename: string,
): {
  token: string;
  path: string;
} {
  const path = resolve(dataDir, filename);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, `${createOpaqueToken()}\n`, { encoding: "utf8", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      // Windows ACLs are controlled by the containing user profile directory.
    }
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < 32) throw new Error(`CrossAgent credential file is invalid: ${filename}`);
  return { token, path };
}

/** Kept as the compatibility entry point for the ordinary Agent bearer. */
export function loadOrCreateToken(dataDir: string): { token: string; path: string } {
  return loadOrCreateCredentialFile(dataDir, "token");
}

export class CredentialRegistry {
  constructor(
    private readonly sqlite: Database.Database,
    readonly credentials: LocalCredentials,
  ) {}

  authenticate(
    request: FastifyRequest,
    requiredScopes: readonly CredentialScope[],
  ): RequestPrincipal {
    return this.authenticatePresented(request, requiredScopes);
  }

  authenticateBearer(
    request: FastifyRequest,
    requiredScopes: readonly CredentialScope[],
  ): RequestPrincipal {
    return this.authenticatePresented(request, requiredScopes, ["authorization_bearer"]);
  }

  private authenticatePresented(
    request: FastifyRequest,
    requiredScopes: readonly CredentialScope[],
    allowedVia?: PresentedCredential["via"][],
  ): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || (allowedVia && !allowedVia.includes(presented.via))) {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const now = new Date().toISOString();
    const totalDigestMatches = Number(
      this.sqlite
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?) +
             (SELECT COUNT(*) FROM adapter_session_tickets WHERE token_sha256 = ?)`,
        )
        .pluck()
        .get(digest, digest),
    );
    const staticRows = this.sqlite
      .prepare(
        `SELECT c.id AS credential_id, p.id AS principal_id, p.kind, p.display_name, p.project_id, p.client_type,
                c.scopes_json
         FROM auth_credentials c
         JOIN auth_principals p ON p.id = c.principal_id
         WHERE c.token_sha256 = ?
           AND c.revoked_at IS NULL
           AND (c.expires_at IS NULL OR unixepoch(c.expires_at) > unixepoch(?))
           AND p.status = 'ACTIVE'`,
      )
      .all(digest, now) as CredentialRow[];
    const ticketRows = findActiveSessionTicketsByDigest(this.sqlite, digest, now);
    if (totalDigestMatches !== 1 || staticRows.length + ticketRows.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous local bearer token");
    }
    if (ticketRows.length !== 0 && presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Session tickets require an Authorization bearer");
    }
    const principal = staticRows[0]
      ? staticPrincipal(staticRows[0], presented.via)
      : ticketPrincipal(ticketRows[0]!, presented.via);
    const scopes = principal.scopes;
    if (requiredScopes.some((scope) => !scopes.includes(scope))) {
      throw new ForbiddenError("Credential does not have the required scope");
    }
    requestPrincipals.set(request, principal);
    return principal;
  }

  /** MODEL_MCP may perform only the MCP protocol handshake while its bundle is still pending. */
  authenticateModelMcpHandshake(request: FastifyRequest): RequestPrincipal {
    return this.authenticatePendingTicket(request, "MODEL_MCP");
  }

  /** The pending CONTROL bearer is the possession proof for first-lineage registration only. */
  authenticatePendingControlEnrollment(request: FastifyRequest): RequestPrincipal {
    return this.authenticatePendingTicket(request, "CONTROL");
  }

  private authenticatePendingTicket(
    request: FastifyRequest,
    purpose: "MODEL_MCP" | "CONTROL",
  ): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const staticCount = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?")
        .pluck()
        .get(digest),
    );
    const tickets = findPendingSessionTicketByDigest(
      this.sqlite,
      digest,
      purpose,
      new Date().toISOString(),
    );
    if (staticCount !== 0 || tickets.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous local bearer token");
    }
    const principal = ticketPrincipal(tickets[0]!, presented.via);
    requestPrincipals.set(request, principal);
    return principal;
  }

  /**
   * Narrow lost-response seam for session close. It grants no scopes; the close Store must still
   * match the original idempotency key/request fingerprint before returning a cached receipt.
   */
  authenticateTerminalTicketReplay(
    request: FastifyRequest,
    expected: { hubSessionId: string },
  ): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const staticCount = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?")
        .pluck()
        .get(digest),
    );
    const tickets = findTerminalSessionTicketsByDigest(this.sqlite, digest).filter(
      (ticket) => ticket.purpose === "CONTROL" && ticket.hubSessionId === expected.hubSessionId,
    );
    if (staticCount !== 0 || tickets.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous terminal ticket replay");
    }
    const principal = ticketPrincipal(tickets[0]!, presented.via);
    requestPrincipals.set(request, principal);
    return principal;
  }

  /** Terminal CAPTURE lost-response replay only; exact receipt/idempotency is enforced by Store. */
  authenticateTerminalCaptureReplay(request: FastifyRequest): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const staticCount = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?")
        .pluck()
        .get(digest),
    );
    const tickets = findTerminalSessionTicketsByDigest(this.sqlite, digest).filter(
      (ticket) => ticket.purpose === "CAPTURE",
    );
    if (staticCount !== 0 || tickets.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous terminal CAPTURE replay");
    }
    const principal = ticketPrincipal(tickets[0]!, presented.via);
    requestPrincipals.set(request, principal);
    return principal;
  }

  /**
   * Zero-scope recovery identity for an exact session whose persisted CONTROL bundle has crossed
   * its 24-hour expiry. The close Store must materialize EXPIRED and close the same session in one
   * transaction; this method never revives, extends, or grants data-plane scopes.
   */
  authenticateExpiredTicketCloseRecovery(
    request: FastifyRequest,
    expected: { hubSessionId: string; now?: string },
  ): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const staticCount = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?")
        .pluck()
        .get(digest),
    );
    const tickets = findExpiredActiveControlTicketsByDigest(
      this.sqlite,
      digest,
      expected.now ?? new Date().toISOString(),
    ).filter((ticket) => ticket.hubSessionId === expected.hubSessionId);
    if (staticCount !== 0 || tickets.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous expired ticket recovery");
    }
    const principal = ticketPrincipal(tickets[0]!, presented.via);
    requestPrincipals.set(request, principal);
    return principal;
  }

  /**
   * Dormant Adapter replacement proof. It grants no scopes and accepts only an exact terminal
   * EXPIRED CONTROL ticket, or the same exact whole bundle after its persisted expiry elapsed but
   * before materialization. The original session must remain the open current lineage head.
   */
  authenticateExpiredControlReplacementRecovery(
    request: FastifyRequest,
    now = new Date().toISOString(),
  ): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const staticCount = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?")
        .pluck()
        .get(digest),
    );
    const tickets = findDormantCurrentHeadControlTicketsByDigest(this.sqlite, digest, now);
    if (staticCount !== 0 || tickets.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous expired CONTROL recovery");
    }
    const principal = ticketPrincipal(tickets[0]!, presented.via);
    requestPrincipals.set(request, principal);
    return principal;
  }

  /**
   * Zero-scope proof for deciding whether an auxiliary rotation committed before Hub disappeared.
   * Store still verifies the exact idempotency receipt or the complete unbound successor bundle.
   */
  authenticateExpiredTicketRotationRecovery(
    request: FastifyRequest,
    expected: { hubSessionId: string; now?: string },
  ): RequestPrincipal {
    const presented = extractPresentedCredential(request);
    if (!presented || presented.via !== "authorization_bearer") {
      throw new ForbiddenError("Missing or invalid local bearer token");
    }
    const digest = tokenSha256(presented.token);
    const staticCount = Number(
      this.sqlite
        .prepare("SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = ?")
        .pluck()
        .get(digest),
    );
    const tickets = findDormantCurrentHeadControlTicketsByDigest(
      this.sqlite,
      digest,
      expected.now ?? new Date().toISOString(),
    ).filter((ticket) => ticket.hubSessionId === expected.hubSessionId);
    if (staticCount !== 0 || tickets.length !== 1) {
      throw new ForbiddenError("Missing, invalid, or ambiguous expired rotation recovery");
    }
    const principal = ticketPrincipal(tickets[0]!, presented.via);
    requestPrincipals.set(request, principal);
    return principal;
  }

  authenticateAny(
    request: FastifyRequest,
    allowedScopes: readonly CredentialScope[],
  ): RequestPrincipal {
    const principal = this.authenticate(request, []);
    if (!allowedScopes.some((scope) => principal.scopes.includes(scope))) {
      throw new ForbiddenError("Credential does not have an allowed scope");
    }
    return principal;
  }

  revalidate(principal: RequestPrincipal): RequestPrincipal {
    if (principal.authenticatedVia === "bootstrap") {
      throw new ForbiddenError("Bootstrap identities cannot authenticate a request");
    }
    if (principal.credentialClass === "SESSION_TICKET") {
      const tickets = findActiveSessionTicketById(
        this.sqlite,
        principal.credentialId,
        new Date().toISOString(),
      );
      if (tickets.length !== 1) {
        throw new ForbiddenError("Credential is no longer active");
      }
      const ticket = tickets[0]!;
      const collisionCount = Number(
        this.sqlite
          .prepare(
            "SELECT COUNT(*) FROM auth_credentials WHERE token_sha256 = (SELECT token_sha256 FROM adapter_session_tickets WHERE id = ?)",
          )
          .pluck()
          .get(principal.credentialId),
      );
      if (collisionCount !== 0 || ticket.principalId !== principal.id) {
        throw new ForbiddenError("Credential is no longer active");
      }
      return ticketPrincipal(ticket, principal.authenticatedVia);
    }
    const row = this.sqlite
      .prepare(
        `SELECT c.id AS credential_id, p.id AS principal_id, p.kind, p.display_name, p.project_id,
                p.client_type, c.scopes_json
         FROM auth_credentials c
         JOIN auth_principals p ON p.id = c.principal_id
         WHERE c.id = ? AND c.revoked_at IS NULL
            AND (c.expires_at IS NULL OR unixepoch(c.expires_at) > unixepoch(?))
           AND p.status = 'ACTIVE'`,
      )
      .get(principal.credentialId, new Date().toISOString()) as CredentialRow | undefined;
    if (!row || row.principal_id !== principal.id) {
      throw new ForbiddenError("Credential is no longer active");
    }
    const ticketCollisionCount = Number(
      this.sqlite
        .prepare(
          `SELECT COUNT(*) FROM adapter_session_tickets
           WHERE token_sha256 = (SELECT token_sha256 FROM auth_credentials WHERE id = ?)`,
        )
        .pluck()
        .get(principal.credentialId),
    );
    if (ticketCollisionCount !== 0) {
      throw new ForbiddenError("Credential is no longer active");
    }
    return staticPrincipal(row, principal.authenticatedVia);
  }
}

function staticPrincipal(
  row: CredentialRow,
  via: RequestPrincipal["authenticatedVia"],
): RequestPrincipal {
  return {
    id: row.principal_id,
    credentialId: row.credential_id,
    credentialClass: "STATIC",
    kind: row.kind,
    displayName: row.display_name,
    scopes: JSON.parse(row.scopes_json) as CredentialScope[],
    projectId: row.project_id,
    clientType: row.client_type,
    hubSessionId: null,
    agentId: row.client_type,
    adapterClient: row.client_type,
    lineageId: null,
    incarnation: null,
    ticketPurpose: null,
    ticketState: null,
    authenticatedVia: via,
  };
}

function ticketPrincipal(
  ticket: SessionTicketAuthentication,
  via: RequestPrincipal["authenticatedVia"],
): RequestPrincipal {
  return {
    id: ticket.principalId,
    credentialId: ticket.id,
    credentialClass: "SESSION_TICKET",
    kind: ticket.principalKind,
    displayName: ticket.displayName,
    scopes: ticket.scopes,
    projectId: ticket.projectId,
    clientType: ticket.adapterClient,
    hubSessionId: ticket.hubSessionId,
    agentId: ticket.agentId,
    adapterClient: ticket.adapterClient,
    lineageId: ticket.lineageId,
    incarnation: ticket.incarnation,
    ticketPurpose: ticket.purpose,
    ticketState: ticket.state,
    authenticatedVia: via,
  };
}

/**
 * The display name a principal already carries, or null on a database that has none yet.
 *
 * Migration 0007 seeded the Dashboard principal with the original author's personal handle and 0014
 * renames it, but the two are not interchangeable and both are needed. The migration fixes the name
 * a user actually sees; this fixes what registerCredential may assume, because it can be handed a
 * database that has not reached 0014 -- migration-integrity covers exactly that, initialising the
 * registry against a version-9 schema. Asserting a hardcoded string there would refuse to start over
 * a name. Deferring to the stored value keeps the exact-match check intact for every other principal
 * while letting this one be corrected by migration rather than by assertion.
 */
function storedPrincipalDisplayName(sqlite: Database.Database, principalId: string): string | null {
  const row = sqlite
    .prepare("SELECT display_name FROM auth_principals WHERE id = ?")
    .get(principalId) as { display_name: string } | undefined;
  return row?.display_name ?? null;
}

function registerCredential(
  sqlite: Database.Database,
  input: {
    principalId: string;
    credentialId: string;
    token: string;
    kind: PrincipalKind;
    displayName: string;
    scopes: CredentialScope[];
    projectId?: string;
    clientType?: "codex" | "claude";
  },
): RequestPrincipal {
  const now = new Date().toISOString();
  const projectId = input.projectId ?? null;
  const clientType = input.clientType ?? null;
  const scopesJson = JSON.stringify([...new Set(input.scopes)].sort());
  const tokenDigest = tokenSha256(input.token);
  sqlite
    .prepare(
      `INSERT INTO auth_principals(
         id, kind, display_name, project_id, client_type, session_id, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(input.principalId, input.kind, input.displayName, projectId, clientType, null, now, now);
  const registeredPrincipal = sqlite
    .prepare(
      `SELECT kind, display_name, project_id, client_type, session_id
       FROM auth_principals WHERE id = ?`,
    )
    .get(input.principalId) as
    | {
        kind: PrincipalKind;
        display_name: string;
        project_id: string | null;
        client_type: "codex" | "claude" | null;
        session_id: string | null;
      }
    | undefined;
  if (
    !registeredPrincipal ||
    registeredPrincipal.kind !== input.kind ||
    registeredPrincipal.display_name !== input.displayName ||
    registeredPrincipal.project_id !== projectId ||
    registeredPrincipal.client_type !== clientType ||
    registeredPrincipal.session_id !== null
  ) {
    throw new Error(`CrossAgent principal identity mismatch: ${input.principalId}`);
  }
  sqlite
    .prepare(
      `INSERT INTO auth_credentials(
         id, principal_id, token_sha256, scopes_json, expires_at, revoked_at, created_at
       ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(input.credentialId, input.principalId, tokenDigest, scopesJson, now);
  const registeredCredential = sqlite
    .prepare(
      `SELECT principal_id, token_sha256, scopes_json, expires_at
       FROM auth_credentials WHERE id = ?`,
    )
    .get(input.credentialId) as
    | {
        principal_id: string;
        token_sha256: string;
        scopes_json: string;
        expires_at: string | null;
      }
    | undefined;
  if (
    !registeredCredential ||
    registeredCredential.principal_id !== input.principalId ||
    registeredCredential.token_sha256 !== tokenDigest ||
    registeredCredential.scopes_json !== scopesJson ||
    registeredCredential.expires_at !== null
  ) {
    throw new Error(`CrossAgent credential identity mismatch: ${input.credentialId}`);
  }
  return {
    id: input.principalId,
    credentialId: input.credentialId,
    credentialClass: "STATIC",
    kind: input.kind,
    displayName: input.displayName,
    scopes: input.scopes,
    projectId,
    clientType,
    hubSessionId: null,
    agentId: clientType,
    adapterClient: clientType,
    lineageId: null,
    incarnation: null,
    ticketPurpose: null,
    ticketState: null,
    authenticatedVia: "bootstrap",
  };
}

export function initializeCredentialRegistry(
  sqlite: Database.Database,
  dataDir: string,
): CredentialRegistry {
  const agentFile = loadOrCreateCredentialFile(dataDir, "token");
  const codexAgentFile = loadOrCreateCredentialFile(dataDir, "agent-codex-token");
  const claudeAgentFile = loadOrCreateCredentialFile(dataDir, "agent-claude-token");
  const dashboardFile = loadOrCreateCredentialFile(dataDir, "dashboard-token");
  const codexCaptureFile = loadOrCreateCredentialFile(dataDir, "capture-codex-token");
  const claudeCaptureFile = loadOrCreateCredentialFile(dataDir, "capture-claude-token");
  const codexInjectorFile = loadOrCreateCredentialFile(dataDir, "inject-codex-token");
  const claudeInjectorFile = loadOrCreateCredentialFile(dataDir, "inject-claude-token");
  const transaction = sqlite.transaction(() => {
    const agent = registerCredential(sqlite, {
      principalId: "prn_local_agent",
      credentialId: "crd_local_agent",
      token: agentFile.token,
      kind: "AGENT",
      displayName: "Local Agent",
      scopes: ["project:select"],
    });
    const codexAgent = registerCredential(sqlite, {
      principalId: "prn_agent_codex",
      credentialId: "crd_agent_codex",
      token: codexAgentFile.token,
      kind: "AGENT",
      displayName: "Codex Agent",
      scopes: [...STATIC_ADAPTER_SCOPES.AGENT],
      clientType: "codex",
    });
    const claudeAgent = registerCredential(sqlite, {
      principalId: "prn_agent_claude",
      credentialId: "crd_agent_claude",
      token: claudeAgentFile.token,
      kind: "AGENT",
      displayName: "Claude Agent",
      scopes: [...STATIC_ADAPTER_SCOPES.AGENT],
      clientType: "claude",
    });
    const dashboard = registerCredential(sqlite, {
      principalId: "prn_local_dashboard",
      credentialId: "crd_local_dashboard",
      token: dashboardFile.token,
      kind: "DASHBOARD_USER",
      displayName: storedPrincipalDisplayName(sqlite, "prn_local_dashboard") ?? "Local User",
      scopes: ["hub:dashboard"],
    });
    const codex = registerCredential(sqlite, {
      principalId: "prn_capture_codex",
      credentialId: "crd_capture_codex",
      token: codexCaptureFile.token,
      kind: "BRIDGE_CAPTURE",
      displayName: "Codex UserPromptSubmit Capture",
      scopes: [...STATIC_ADAPTER_SCOPES.CAPTURE],
      clientType: "codex",
    });
    const claude = registerCredential(sqlite, {
      principalId: "prn_capture_claude",
      credentialId: "crd_capture_claude",
      token: claudeCaptureFile.token,
      kind: "BRIDGE_CAPTURE",
      displayName: "Claude UserPromptSubmit Capture",
      scopes: [...STATIC_ADAPTER_SCOPES.CAPTURE],
      clientType: "claude",
    });
    const codexInjector = registerCredential(sqlite, {
      principalId: "prn_inject_codex",
      credentialId: "crd_inject_codex",
      token: codexInjectorFile.token,
      kind: "BRIDGE_INJECTOR",
      displayName: "Codex Synthetic Prompt Injector",
      scopes: [...STATIC_ADAPTER_SCOPES.INJECTOR],
      clientType: "codex",
    });
    const claudeInjector = registerCredential(sqlite, {
      principalId: "prn_inject_claude",
      credentialId: "crd_inject_claude",
      token: claudeInjectorFile.token,
      kind: "BRIDGE_INJECTOR",
      displayName: "Claude Synthetic Prompt Injector",
      scopes: [...STATIC_ADAPTER_SCOPES.INJECTOR],
      clientType: "claude",
    });
    return {
      agent,
      codexAgent,
      claudeAgent,
      dashboard,
      codex,
      claude,
      codexInjector,
      claudeInjector,
    };
  });
  const principals = transaction();
  return new CredentialRegistry(sqlite, {
    agent: { ...agentFile, principal: principals.agent },
    agentByClient: {
      codex: { ...codexAgentFile, principal: principals.codexAgent },
      claude: { ...claudeAgentFile, principal: principals.claudeAgent },
    },
    dashboard: { ...dashboardFile, principal: principals.dashboard },
    capture: {
      codex: { ...codexCaptureFile, principal: principals.codex },
      claude: { ...claudeCaptureFile, principal: principals.claude },
    },
    injector: {
      codex: { ...codexInjectorFile, principal: principals.codexInjector },
      claude: { ...claudeInjectorFile, principal: principals.claudeInjector },
    },
  });
}

export function tokenMatches(expected: string, received?: string): boolean {
  if (!received) return false;
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

export function extractToken(request: FastifyRequest): string | undefined {
  return extractPresentedCredential(request)?.token;
}

function extractPresentedCredential(request: FastifyRequest): PresentedCredential | undefined {
  const authorization = request.headers.authorization;
  if (authorization?.startsWith("Bearer ")) {
    return { token: authorization.slice(7), via: "authorization_bearer" };
  }
  const header = request.headers["x-crossagent-token"];
  if (typeof header === "string") return { token: header, via: "x_crossagent_token" };
  const cookie = request.headers.cookie
    ?.split(";")
    .map((part) => part.trim().split("="))
    .find(([name]) => name === "crossagent_token");
  return cookie?.[1]
    ? { token: decodeURIComponent(cookie[1]), via: "dashboard_cookie" }
    : undefined;
}

/** Compatibility helper used by transports that intentionally accept exactly one bearer. */
export function assertAuthorized(request: FastifyRequest, expectedToken: string): void {
  if (!tokenMatches(expectedToken, extractToken(request))) {
    throw new ForbiddenError("Missing or invalid local bearer token");
  }
}

export function assertAnyTokenAuthorized(request: FastifyRequest, expectedTokens: string[]): void {
  const received = extractToken(request);
  if (!expectedTokens.some((token) => tokenMatches(token, received))) {
    throw new ForbiddenError("Missing or invalid local bearer token");
  }
}

export function requestPrincipal(request: FastifyRequest): RequestPrincipal {
  const principal = requestPrincipals.get(request);
  if (!principal) throw new ForbiddenError("Request principal was not authenticated");
  return principal;
}

export function assertPrincipalKind(
  principal: RequestPrincipal,
  ...allowed: PrincipalKind[]
): void {
  if (!allowed.includes(principal.kind)) {
    throw new ForbiddenError(`Principal kind ${principal.kind} cannot perform this operation`);
  }
}

export function assertLocalOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (!origin) return;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new ForbiddenError("Invalid Origin header");
  }
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new ForbiddenError("CrossAgent Hub only accepts localhost origins");
  }
}
