# Multi-session succession and message-surface race

## Summary

Two Codex Bridge processes bound to the same logical Desktop thread could both become plausible owners of the same work. The Hub previously used request commit order as session succession order, and a recipient claim was only a point-in-time check before the Bridge crossed the external Codex app-server boundary. A delayed registration could therefore reverse-supersede a newer process, while a replacement committed between `claim` and the app-server RPC could let both processes surface the same message.

A separate SQLite schema defect made this worse: the original three-column `UNIQUE(message_id, recipient_agent_id, recipient_session_id)` constraint admits multiple rows when `recipient_session_id` is `NULL`. Two sessions could then claim different rows for one logical agent-wide recipient.

Severity: **Critical** for unattended collaboration. The unsafe outcomes are duplicated user-visible instructions, work ownership moving back to an older process, or a message being reported against the wrong session incarnation.

Status: **Implemented and regression-tested; controlled runtime deployment is pending.**

No credential or bearer token is included in this report.

## Root causes

### 1. Session replacement had no lineage compare-and-swap

Registration found all matching live sessions at mutation time, closed them, and migrated their ownership to the registering process. If an older process's request reached the database after a newer process had registered, the older request became the winner. A stable external thread id described identity but did not prove succession.

The corrected model makes the logical worker a first-class `session_lineages` row. A Codex app-server registration must submit the head it observed, including an explicit `null` for the first incarnation. The registration transaction compares that value with the current head, inserts exactly one next incarnation, advances the lineage, and supersedes only the exact predecessor. A stale request fails with `SESSION_INCARNATION_CONFLICT` and leaves no session, event, ownership move, or idempotency response.

### 2. Recipient claim and external side effect were separated by a TOCTOU window

The old claim transaction answered “this session owns the row now.” It could not reserve the later `turn/start`, `turn/steer`, or `thread/inject_items` side effect. A same-thread replacement could commit after the claim returned but before the app-server call.

The corrected model separates:

- a soft recipient claim, which selects a local queue owner; and
- a persisted surface permit, which is the only authority to cross the app-server seam.

Permit acquisition and session replacement serialize in SQLite:

1. If permit acquisition commits first, the predecessor keeps that recipient and the successor receives `MESSAGE_SURFACE_IN_FLIGHT`.
2. If replacement commits first, the predecessor is no longer the lineage head and cannot acquire a permit.

The Bridge obtains the permit immediately before every wake, steer, or inject. A confirmed delivery includes the exact surface-attempt id and recipient fence.

### 3. Nullable recipient uniqueness was only row-level

SQLite treats `NULL` values as distinct for uniqueness checks. Multiple identical agent-wide recipients could therefore exist and be independently claimed.

The corrected contract has three layers:

- Protocol validation rejects an exact duplicate and rejects an unbound target mixed with any other target for the same agent.
- Store validation repeats the same rule for internal callers that bypass HTTP parsing.
- A partial unique index prevents two unbound `(message_id, recipient_agent_id)` rows from committing.

Distinct explicit session targets remain a supported fan-out contract. The fix does not silently collapse them into one agent-wide recipient.

## Surface-attempt state machine

`message_surface_attempts` uses four states:

- `ACTIVE`: the named session may make the one external attempt.
- `CONFIRMED`: the exact attempt and fence were accepted as delivered.
- `ABORTED`: the caller proved the external side effect did not occur; ownership may move to the current successor.
- `AMBIGUOUS`: an RPC may have reached Codex, but its outcome is not knowable; neither the same session nor a successor may automatically retry.

Only a proven `ABORTED` attempt releases work. There is deliberately no TTL, lease stealing, or routine-heartbeat retry for `AMBIGUOUS`: a delayed external RPC can outlive any local timeout, so expiry would reopen duplicate delivery.

A predecessor that already owns an `ACTIVE` or `AMBIGUOUS` permit is closed for new work but remains authorized to settle that exact attempt. On exact confirmation, follow-up ACK/processing ownership can move to the current lineage head while delivery audit remains attributed to the process that actually surfaced the message.

The compatibility `/delivered` path remains available only when no unresolved surface attempt exists. It cannot bypass a permit.

## Migration

Migration `0005_session_surface_fences.sql`:

1. Creates stable lineage rows for primary sessions with an explicit external thread or external session identity.
2. Backfills incarnation, predecessor, successor, and head.
3. Uses immutable `session.registered` project sequence when every session in a lineage has that evidence. If any registration event is missing, the entire lineage uses the deterministic `connected_at, id` fallback; it never mixes the two orderings within one lineage.
4. Adds the recipient surface fence and final unbound-recipient unique index.
5. Creates the surface-attempt table and permits at most one unresolved `ACTIVE` or `AMBIGUOUS` attempt per recipient.

The unique-index creation is intentionally fail-closed. An installation with unsafe pre-existing duplicate unbound recipients will fail the migration transaction and retain its pre-migration backup rather than silently delete rows, cascade away delivery evidence, or rewrite cached idempotency responses.

Rollback is binary-compatible only in the forward direction: an older binary can read the original columns, but dropping the new integrity constraints would reopen the race. If deployment must be reverted, restore the automatic pre-migration database backup and the previous binary together while all Hub writers are stopped.

## Bridge behavior

At startup the Bridge reads the current lineage head once and registers against that observed value. It does not handle a conflict by reading the new head and blindly retrying, because that would let an old process “catch up” and reverse-supersede repeatedly.

Before a user-visible app-server call, the Bridge:

1. revalidates or claims the recipient as needed;
2. acquires the persisted surface permit;
3. rechecks its socket generation;
4. crosses the app-server seam;
5. records `ABORTED` only for an explicit rejection that proves no side effect, otherwise records `AMBIGUOUS`;
6. marks delivery only with the exact attempt id and recipient fence.

An indeterminate result does not restart the transport and replay the message. Liveness is intentionally subordinate to at-most-once user-visible behavior until downstream evidence or a human decision resolves the ambiguity.

## Verification

The focused implementation suite currently covers:

- delayed stale registration and two successors racing from one expected head;
- failed-CAS rollback with unchanged sessions, events, and idempotency state;
- distinct logical threads and generic workers remaining independent;
- legacy database backfill, including equal timestamps whose authoritative event sequence conflicts with lexical session-id order;
- protocol, Store, and SQLite duplicate-recipient fences while retaining explicit multi-session fan-out;
- predecessor permit pinning across replacement;
- same-session and successor refusal after `AMBIGUOUS`;
- proven `ABORTED` transfer with a monotonically increasing recipient fence;
- wrong-fence rejection and exact predecessor confirmation;
- Bridge lineage-head registration, permit-before-RPC ordering, and exact permit/fence delivery state.

Six targeted mutations demonstrated that these checks are load-bearing:

1. Removing expected-head comparison changed stale registration from `409` to a successful reverse succession.
2. Migrating recipients with unresolved permits moved an in-flight row to the successor.
3. Reusing an `AMBIGUOUS` permit allowed automatic retry.
4. Calling `turn/start` before permit acquisition produced a user-visible call before the Hub fence.
5. Removing the partial unique index allowed a second unbound row.
6. Removing recipient-fence comparison let an old fence confirm a newer attempt.

Every mutation failed at its intended assertion and the restored implementation returned green.

## Compatibility and security boundaries

- The strict expected-head requirement currently applies to Codex app-server sessions with an explicit logical identity. Generic sessions still coexist, and adapters without that external side effect retain their existing registration behavior.
- An explicit target for two distinct sessions of one agent remains intentional fan-out. An unbound target cannot coexist with explicit targets for that agent in the same message.
- The Hub guarantees that it signs at most one legitimate unresolved surface permit. It cannot prevent a malicious local process from calling the Codex app-server directly without using the Hub.
- The existing local bearer token is still a shared local principal. Lineage and permits are correctness fences, not a replacement for per-process credentials.
- A previously committed registration idempotency response can still describe the session as it looked when it was created. It cannot mutate the lineage on replay, but callers must not treat that cached snapshot as current presence.
- The migration runner and SQLite deployment topology still assume one Hub writer applies schema migrations. Multi-Hub migration coordination is a separate operational hardening item.
- “Newest process” is not inferred from PID or wall-clock time. A process that deliberately reads the current head and registers is an explicit successor. The CAS prevents stale observed-head requests; authoritative launcher ownership is a separate control-plane concern.

## Deployment checklist

1. Stop additional Hub writers and preserve the automatic pre-migration backup.
2. Build Protocol, Client, Hub, and Codex Bridge from the same reviewed commit.
3. Start the Hub and verify migration 0005 plus `/api/health`.
4. Stop the old managed Bridge only after the new Hub is healthy.
5. Start one managed Bridge against the existing project and the original Codex Desktop thread.
6. Verify the new session is the lineage head, the predecessor is closed, and task/write-intent ownership moved only once.
7. Verify Hub socket, app-server RPC, notification stream, and health heartbeat.
8. Keep an ambiguous smoke message unresolved; do not manufacture a second user-visible push merely to prove retry behavior.
