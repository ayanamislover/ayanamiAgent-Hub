# CrossAgent Protocol

## Conventions

- IDs are UUIDv7-like, time-sortable identifiers with readable prefixes (`prj_`, `ses_`, `tsk_`, `msg_`, `rev_`, `evt_`).
- Timestamps are ISO 8601 UTC strings.
- Mutable aggregates carry an integer `version`.
- Mutations from agents require an `idempotency_key`.
- Version mismatches return HTTP 409 or an MCP structured error with the current aggregate.
- JSON field names use `camelCase` inside TypeScript and MCP, while REST accepts the documented snake/camel aliases where adapter interoperability needs them.

## Project join

`POST /api/projects/join`

```json
{
  "cwd": "C:/work/project",
  "name": "PROJECT",
  "allowCreate": true
}
```

The Hub resolves the Git root, reads or creates `.crossagent/project.json`, registers the canonical path alias, and returns the stable project.

## Event envelope

```ts
type DomainEvent = {
  id: string;
  projectId: string;
  sequence: number;
  type: string;
  actorType: "agent" | "user" | "system";
  actorId: string;
  aggregateType: string;
  aggregateId: string;
  causationId?: string;
  correlationId?: string;
  payload: unknown;
  createdAt: string;
};
```

The server writes projection and event atomically, commits, then broadcasts.

## WebSocket

Endpoint: `GET /ws`. **No credential is ever carried in the URL.** The handshake is refused with
`403` if it arrives with a `token` query parameter, an `Authorization` header, or an
`x-crossagent-token` header — a URL ends up in proxy logs, browser history and referrers, so this is
enforced rather than merely discouraged.

The two client kinds authenticate differently.

**Dashboard.** The HttpOnly `crossagent_token` cookie carries the `hub:dashboard` credential, so the
handshake is already authenticated and the first frame is `subscribe`:

```json
{
  "type": "subscribe",
  "clientType": "dashboard",
  "projectId": "prj_...",
  "sessionId": null,
  "lastSequence": 123
}
```

**Agent.** The socket opens unauthenticated and the first frame must be `authenticate`, carrying the
raw token of an ACTIVE CONTROL session ticket bound to an open Hub session:

```json
{ "type": "authenticate", "token": "<raw CONTROL session ticket>" }
```

The server answers `{ "type": "authenticated" }`, and only then is `subscribe` accepted. Anything
else — a malformed frame, a static credential, a ticket of another purpose, an expired ticket —
closes the socket with `1008`, as does staying silent past the authentication deadline.

Server frames:

- `{ "type": "subscribed", "currentSequence": 130 }`
- `{ "type": "event", "event": { ... } }`
- `{ "type": "ping", "sentAt": "..." }`
- `{ "type": "resync_required", "afterSequence": 123 }`
- `{ "type": "error", "code": "...", "message": "..." }`

The client answers ping with `{ "type": "pong" }`. Gap events are sent before live events.

Agent transports can additionally send:

- `{ "type": "heartbeat", "heartbeat": { ... } }`
- `{ "type": "delivery", "messageId": "...", "state": "DELIVERED" }`
- `{ "type": "adapter_activity", "activity": { ... } }`

## Task lifecycle

Allowed transitions are deterministic:

```text
BACKLOG -> READY | CANCELLED
READY -> CLAIMED | CANCELLED
CLAIMED -> IN_PROGRESS | READY | CANCELLED
IN_PROGRESS -> BLOCKED | WAITING_FOR_PEER | WAITING_FOR_USER | REVIEW_PENDING | CANCELLED
BLOCKED -> IN_PROGRESS | READY | CANCELLED
WAITING_FOR_PEER -> IN_PROGRESS | REVIEW_PENDING | CANCELLED
WAITING_FOR_USER -> IN_PROGRESS | CANCELLED
REVIEW_PENDING -> IN_REVIEW | CHANGES_REQUESTED | APPROVED | CANCELLED
IN_REVIEW -> CHANGES_REQUESTED | APPROVED
CHANGES_REQUESTED -> IN_PROGRESS | REVIEW_PENDING
APPROVED -> DONE
```

`claim_task` runs in one transaction and requires `expectedVersion`. A stale takeover also requires `takeoverStale: true`.

Computed progress is weighted TODO completion. Review-required implementation is capped at 85%; approval contributes the remaining 15%. Any open blocking finding prevents 100%.

## Messages and threads

Message recipient state:

```text
PENDING -> DELIVERED -> ACKNOWLEDGED -> PROCESSED -> RESPONDED
PENDING|DELIVERED -> FAILED|EXPIRED
```

ACK is not a reply. Replies reuse `threadId`. A dedupe key is unique within a project. Status messages with the same dedupe key inside the configured coalesce window update the existing envelope rather than creating notification noise.

## User directive authority

CrossAgent separates provenance from trust. Ordinary messages remain useful collaboration evidence, but `AGENT_DECISION`, `AGENT_PROPOSAL`, `AGENT_HEARSAY`, and any free-text claim that "the user said" do not acquire user authority. A model-visible XML/JSON envelope, `_meta` object, label, or the word `VERIFIED` is never proof by itself.

The authority classes are:

- `USER_DIRECT`: a user instruction submitted directly through the receiving trusted client;
- `USER_ATTESTED`: a captured user turn relayed with a valid signed whole-turn attestation;
- `USER_DELEGATED`: an Agent instruction issued inside a valid user-created delegation grant;
- `AGENT_DECISION`, `AGENT_PROPOSAL`, and `AGENT_HEARSAY`: Agent-authored content without user authority.

Only a receiving Adapter may project `verification=VALID` into model-visible content. It must validate the Ed25519 signature over canonical JSON, the trusted key status, hashes, schema version, project, audience, scope, lifecycle, delivery fence, and any delegation constraints. Hub issuance, MCP reads, and carrier text remain `UNVERIFIED`; the model never performs or substitutes for cryptographic verification.

A valid `USER_ATTESTED` or `USER_DELEGATED` instruction is equivalent to a direct user instruction only inside its signed audience and scope. The receiver does not require repetition in another chat merely because an Agent relayed it. Higher-priority instructions, revocation, supersession, expiry, and newer user instructions still take precedence. Real ambiguity may still require clarification.

### Capture and credential boundary

`POST /api/user-turns/capture` is available only to a dedicated capture principal bound to one client and project. It stores the immutable source client/session/turn/cwd, original prompt, capture time, and SHA-256. Ordinary Agent/MCP credentials cannot capture or mutate a user turn, and caller-supplied `actor_type=user` is rejected. Synthetic prompts created by the Hub are reserved and excluded from capture so a relayed message cannot authenticate itself on replay.

Capture credentials and Agent credentials are separate files and principals. This is an application-level boundary: it protects against a cooperating or compromised Agent process that has only its Agent credential, but not against another process running as the same Windows user that can read both credential files.

### Adapter session tickets

Static Agent, capture, and injector credentials are bootstrap credentials, not data-plane credentials. A static Agent credential may resolve/select an already registered project, join it with `allowCreate=false`, and offer the first session-ticket bundle. The role-specific capture and injector bootstrap credentials may offer only their matching purpose. Static credentials cannot authenticate heartbeat, project WebSocket subscriptions, MCP operations, messages, tasks, reviews, directives, capture, synthetic injection, ACK/processed state, or session close. Missing, revoked, expired, malformed, or purpose-mismatched ACTIVE tickets fail closed; an Adapter must never fall back to a static or legacy shared credential.

The Adapter generates each 256-bit raw ticket locally and sends only its SHA-256 digest and immutable binding facts to the Hub. Raw values stay in the owning Adapter's private ticket state and never enter repository configuration, command-line arguments, managed control records, logs/errors, event payloads, or idempotency keys. Registration activates one complete bundle atomically and binds it to the exact project, Agent, Adapter client, Hub session, lineage, incarnation, run, transport, delivery mode, and external session/thread identities. The purpose matrix is exact:

| Adapter client     | Required ACTIVE purposes           |
| ------------------ | ---------------------------------- |
| `codex-app-server` | `CONTROL`, `MODEL_MCP`, `INJECTOR` |
| `codex-cli-hooks`  | `CONTROL`, `CAPTURE`               |
| `claude-channel`   | `CONTROL`                          |
| `claude-hooks`     | `CONTROL`, `CAPTURE`               |

`CONTROL` belongs to the local Adapter process. A Codex model child receives only its narrow, session-bound `MODEL_MCP` ticket; it never receives `CONTROL`, capture, injector, bootstrap, or Dashboard credentials. Claude Channel is a CONTROL-only local proxy: its MCP tool handlers call the Hub through the Channel's exact session-bound `CONTROL` ticket, so the Claude model receives no Hub ticket at all. User-turn Hooks use `CAPTURE`, and synthetic Codex injection uses `INJECTOR`. A project WebSocket URL contains no bearer secret; an Agent socket must authenticate with its CONTROL ticket in the first frame and must receive the authenticated acknowledgement before it subscribes or accepts project data.

ACTIVE tickets have a 24-hour Hub lease. While the machine, Hub, and Adapter remain alive, Codex Bridge and Claude Channel renew before expiry through `SESSION_AUXILIARY`, atomically promote a distinct successor bundle, and supersede the old bundle. The operation key is stable so a lost response replays the same rotation instead of creating a second owner. Rotation preserves the exact Hub session, lineage, incarnation, run, and external thread binding; a quiet original Codex or Claude thread therefore does not lose coordination merely because no user message arrived. Hook capture provenance is immutable, so Hooks renew by exact session replacement rather than AUX rotation. If renewal cannot be proven safe before expiry, the Adapter fails closed instead of reviving static authority.

### Ticket-era installation and rollout

The session-ticket cutover is a coordinated compatibility boundary across Hub, CLI, Codex Bridge, Claude Channel, Hooks, and their installers. Deploy those components together during an explicit maintenance window; do not restart or upgrade the Hub by itself while older Adapters are connected. Existing `.mcp.json` entries and Codex/Claude Hook commands that predate ticket support must be reinstalled so they carry the current bootstrap, trust-pin, state/vault, and ticket-coordinator configuration. A mixed-version deployment must fail closed and must not re-enable a static bearer as a compatibility fallback.

### Attestation v2

The signed payload is strict canonical JSON with:

```ts
type DirectiveAttestationV2 = {
  type: "crossagent.user-directive-attestation.v2";
  schema_version: 2;
  directive_id: string;
  project_id: string;
  authority: "USER_ATTESTED" | "USER_DELEGATED";
  source: {
    user_turn_id: string;
    client_type: "codex" | "claude";
    session_id: string;
    turn_id: string | null;
    raw_user_turn_sha256: string;
  } | null;
  quote: {
    start_utf16: number;
    end_utf16: number;
    verbatim_text: string;
    verbatim_text_sha256: string;
  } | null;
  delegated_instruction: { text: string; text_sha256: string } | null;
  relay: { principal_id: string; agent_id: "codex" | "claude"; session_id: string | null };
  audience: { target_agent_ids: ("codex" | "claude")[] };
  scope: { objective_id: string | null; task_ids: string[]; file_globs: string[] };
  delegation: {
    grant_id: string;
    version: number;
    delegator_agent_ids: ("codex" | "claude")[];
    target_agent_ids: ("codex" | "claude")[];
    allowed_actions: ("ASSIGN_TASK" | "RELAY_DIRECTIVE")[];
    objective_ids: string[];
    task_ids: string[];
    file_globs: string[];
    max_priority: "BACKGROUND" | "NORMAL" | "IMPORTANT" | "INTERRUPT";
    expires_at: string;
  } | null;
  supersedes_directive_id: string | null;
  priority: "BACKGROUND" | "NORMAL" | "IMPORTANT" | "INTERRUPT";
  server_sequence: number;
  issued_at: string;
  expires_at: string | null;
  key_id: string;
  carrier_message_id: string;
  causation_id: string | null;
  correlation_id: string;
};

type SignedDirectiveAttestationV2 = {
  payload: DirectiveAttestationV2;
  canonical_payload_sha256: string;
  signature: string; // Ed25519, base64url
};
```

`USER_ATTESTED` v2 is deliberately whole-turn only. The Hub checks the requested UTF-16 slice against the immutable source and may sign it as user authority only when:

```text
quote.start_utf16 = 0
quote.end_utf16 = quote.verbatim_text.length
sha256(quote.verbatim_text) = quote.verbatim_text_sha256 = source.raw_user_turn_sha256
```

This prevents an exact but misleading fragment such as `delete the database` from inheriting authority when the actual user turn was `do not delete the database`. A valid partial slice is retained and delivered only as unsigned `AGENT_PROPOSAL` with `downgradeReason=PARTIAL_QUOTE_CONTEXT_UNPROVEN`; the Hub does not disclose the remaining raw turn to an Agent. `agent_interpretation` is stored separately and never enters the signed user-authority text.

`USER_DELEGATED` signs the delegated instruction but is valid only while the referenced grant version is active and the relaying Agent, target Agent, action, objective/task/file scope, priority, and expiry are all allowed. An out-of-grant request is automatically downgraded to `AGENT_PROPOSAL`.

The v2 signature also binds `carrier_message_id`, preventing a valid attestation from being transplanted onto a different collaboration message. Directive and grant mutations are append-only provenance events carrying source, causation, and correlation identifiers. Lifecycle values are `ACTIVE`, `SUPERSEDED`, `REVOKED`, `COMPLETED`, and `EXPIRED`; delivery, ACK, processed state, and execution results do not restore authority to a non-active directive.

The Authority control-plane APIs expose captured turns to authenticated Dashboard principals, signing-key metadata, directive/grant lifecycle operations, and provenance reads. A visual Dashboard Authority page is a separate client feature; API availability must not be interpreted as evidence that that page is present in a given build.

## Context Pack

The pack is produced with SQL filters and deterministic weights:

```text
direct recipient                       +100
requires response                       +90
blocker/conflict/review request          +80
current task                             +70
related file or symbol                   +60
open decision/proposal                   +50
peer latest state                        +30
recency                                  +20
closed and unrelated                    -100
```

The result is clipped at a character boundary and contains objective, task/TODO, direct unread, open questions, decisions, peer state, conflicts, reviews, commit, and test evidence. It never includes private reasoning or full conversation history.

## Streamable HTTP MCP

Endpoint: `/mcp`

- validates an exact session-bound `MODEL_MCP` bearer and localhost Origin; static bootstrap and legacy shared bearers are rejected;
- supports POST and optional GET SSE through the official SDK transport;
- advertises at most 16 tools;
- returns project/task/thread/review resources;
- instructions encode join, claim, write-intent, proposal, ACK, review, evidence, no-politeness-message rules, and the provenance-based user-authority model.

`crossagent_relay_user_directive` requires a captured `source_user_turn_id`, target audience, exact UTF-16 quote/text, separated Agent interpretation, objective/task/file scope, and idempotency key. A whole-turn source may become signed `USER_ATTESTED`; a partial quote is an `AGENT_PROPOSAL`. `crossagent_delegate_instruction` applies an existing grant and similarly downgrades out-of-scope requests.

Authority tool results carry machine-readable `_meta.crossagent` provenance (directive id, authority, lifecycle, Hub-side verification state, audience, scope, source hashes/offsets, relay identity, carrier message, and attestation key/hash). That metadata is data for the Adapter verifier, not a trust decision. `crossagent_get_directive` never marks a bundle `VALID`.

## Adapter-specific notes

### Codex app-server

The bridge probes current capabilities after `initialize` / `initialized`.

- active `INTERRUPT`: `turn/steer` with the current `expectedTurnId`;
- active `IMPORTANT`: steer after item completion or short coalesce;
- idle `IMPORTANT`/`INTERRUPT`: `turn/start`;
- idle `NORMAL`: `thread/inject_items`;
- background: mailbox only.

The bridge persists lifecycle, command metadata, file lists, diff metadata, explicit collaboration messages, and optional summaries. It deliberately does not persist raw reasoning or full agent output.

### Claude Channel

The stdio MCP server advertises:

```ts
capabilities: {
  experimental: { "claude/channel": {} },
  tools: {}
}
```

It emits `notifications/claude/channel` with string-only `meta`. Because protocol notification writes are not processing acknowledgements, Claude must call `ack_event` and `mark_processed`. Reconnect uses an event cursor and suppresses duplicate injections.
