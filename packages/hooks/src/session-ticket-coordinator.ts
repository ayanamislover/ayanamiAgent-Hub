import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { HubClient } from "@crossagent/client";
import type {
  AgentSession,
  SessionTicketOffer,
  SessionTicketOfferInput,
} from "@crossagent/protocol";
import {
  HookSessionTicketStore,
  createInitialTicketRecord,
  createReplacementPendingBundle,
  nextTicketRecord,
  type HookActiveTicketBundle,
  type HookPendingTicketBundle,
  type HookSessionTicketRecord,
  type HookTicketSessionIdentity,
} from "./session-ticket-store.js";

const DEFAULT_REPLACEMENT_WINDOW_MS = 5 * 60 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 2_000;

export type HookSessionRuntime = {
  readonly identity: HookTicketSessionIdentity;
  readonly session: AgentSession;
  readonly controlClient: HubClient;
  readonly captureClient: HubClient;
  readonly captureBinding: HookCaptureTicketBinding;
  readonly receiptClient: HubClient;
  readonly ticketExpiresAt: string;
  markDraining(): Promise<void>;
  close(reason: string): Promise<void>;
};

export type HookCaptureTicketBinding = {
  hubSessionId: string;
  bundleId: string;
  captureOfferId: string;
};

export type HookCaptureReplayChannel = {
  client: HubClient;
  binding: HookCaptureTicketBinding;
};

export type OpenHookTicketSessionInput = {
  identity: HookTicketSessionIdentity;
  cwd: string;
  beforeReplacement?: (channel: HookCaptureReplayChannel) => Promise<"DRAINED" | "BLOCKED">;
};

function bearer(): string {
  return randomBytes(32).toString("base64url");
}

function offerIdempotencyKey(bundle: HookPendingTicketBundle, purpose: "CONTROL" | "CAPTURE") {
  return `hook-offer:v1:${bundle.bundleId}:${purpose.toLowerCase()}`;
}

function offerInput(
  identity: HookTicketSessionIdentity,
  bundle: HookPendingTicketBundle,
  purpose: "CONTROL" | "CAPTURE",
): SessionTicketOfferInput {
  return {
    bundle_id: bundle.bundleId,
    purpose,
    token_sha256: purpose === "CONTROL" ? bundle.control.tokenSha256 : bundle.capture.tokenSha256,
    adapter_client: identity.adapterClient,
    agent_id: identity.agentId,
    session_client: identity.sessionClient,
    role: "primary",
    transport: "hook-poll",
    delivery_mode: "hook_poll",
    external_session_id: identity.externalSessionId,
    external_thread_id: identity.externalThreadId,
    run_id: bundle.runId,
    activation_mode: bundle.activationMode,
    ...(bundle.expectedLineageId ? { expected_lineage_id: bundle.expectedLineageId } : {}),
    ...(bundle.activationMode === "CURRENT_HEAD_REPLACEMENT"
      ? { expected_head_session_id: bundle.expectedHeadSessionId }
      : {}),
    idempotency_key: offerIdempotencyKey(bundle, purpose),
  };
}

function exactActiveBundle(record: HookSessionTicketRecord, active: HookActiveTicketBundle): void {
  const { identity } = record;
  const binding = active.binding;
  if (
    binding.bundleId !== active.bundleId ||
    binding.runId !== active.runId ||
    binding.projectId !== identity.projectId ||
    binding.agentId !== identity.agentId ||
    binding.adapterClient !== identity.adapterClient ||
    binding.hubSessionId !== active.session.id ||
    binding.lineageId !== active.session.lineageId ||
    binding.incarnation !== active.session.incarnation ||
    active.session.client !== identity.sessionClient ||
    active.session.externalSessionId !== identity.externalSessionId ||
    active.session.externalThreadId !== identity.externalThreadId ||
    binding.purposes.length !== 2 ||
    binding.purposes.find((purpose) => purpose.purpose === "CONTROL")?.id !==
      active.control.offerId ||
    binding.purposes.find((purpose) => purpose.purpose === "CAPTURE")?.id !== active.capture.offerId
  ) {
    throw new Error("hook_ticket_active_binding_mismatch");
  }
}

function remainingTicketMs(active: HookActiveTicketBundle, now: Date): number {
  const serverTtl = Date.parse(active.binding.expiresAt) - Date.parse(active.serverNow);
  const locallyObservedElapsed = Math.max(0, now.getTime() - Date.parse(active.observedAt));
  // The server-relative estimate survives a consistently skewed host clock. The absolute estimate
  // is a conservative second guard when the local wall clock jumps forward.
  return Math.min(
    serverTtl - locallyObservedElapsed,
    Date.parse(active.binding.expiresAt) - now.getTime(),
  );
}

function exactOfferReceipt(
  identity: HookTicketSessionIdentity,
  pending: HookPendingTicketBundle,
  purpose: "CONTROL" | "CAPTURE",
  offer: SessionTicketOffer,
  now: Date,
): void {
  if (
    offer.bundle_id !== pending.bundleId ||
    offer.purpose !== purpose ||
    offer.state !== "PENDING" ||
    offer.project_id !== identity.projectId ||
    offer.adapter_client !== identity.adapterClient ||
    offer.agent_id !== identity.agentId ||
    offer.session_client !== identity.sessionClient ||
    offer.role !== "primary" ||
    offer.transport !== "hook-poll" ||
    offer.delivery_mode !== "hook_poll" ||
    offer.external_session_id !== identity.externalSessionId ||
    offer.external_thread_id !== identity.externalThreadId ||
    offer.run_id !== pending.runId ||
    Date.parse(offer.offer_expires_at) <= now.getTime()
  ) {
    throw new Error("hook_ticket_offer_receipt_mismatch");
  }
}

function stableOfferReceiptError(error: unknown): never {
  if (
    (error instanceof Error && error.name === "ZodError") ||
    (error instanceof TypeError &&
      error.message === "Session ticket offer response does not match the enrollment request")
  ) {
    throw new Error("hook_ticket_offer_receipt_mismatch", { cause: error });
  }
  throw error;
}

/**
 * Enrollment is the only Module allowed to use static credentials. Its small Interface yields
 * session-bound clients, giving runner.ts leverage without exposing bootstrap clients at its seam.
 */
export class HookSessionTicketCoordinator {
  private readonly store: HookSessionTicketStore;
  private readonly agentBootstrap: HubClient;
  private readonly captureBootstrap: HubClient;
  private readonly baseClient: HubClient;
  private readonly receiptBaseClient: HubClient;
  private readonly now: () => Date;
  private readonly replacementWindowMs: number;

  constructor(options: {
    store: HookSessionTicketStore;
    agentBootstrapToken: string;
    captureBootstrapToken: string;
    baseUrl: string;
    fetch?: typeof globalThis.fetch;
    now?: () => Date;
    replacementWindowMs?: number;
    requestTimeoutMs?: number;
  }) {
    if (!options.agentBootstrapToken || !options.captureBootstrapToken) {
      throw new Error("hook_ticket_bootstrap_credential_missing");
    }
    this.store = options.store;
    this.baseClient = new HubClient({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.receiptBaseClient = new HubClient({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    });
    this.agentBootstrap = this.baseClient.withToken(options.agentBootstrapToken);
    this.captureBootstrap = this.baseClient.withToken(options.captureBootstrapToken);
    this.now = options.now ?? (() => new Date());
    this.replacementWindowMs = options.replacementWindowMs ?? DEFAULT_REPLACEMENT_WINDOW_MS;
  }

  async open(input: OpenHookTicketSessionInput): Promise<HookSessionRuntime> {
    const active = await this.store.withRecord(input.identity, async (transaction) => {
      let record = transaction.current;
      if (!record) {
        const head = await this.agentBootstrap.getSessionLineageHead(input.identity.projectId, {
          agentId: input.identity.agentId,
          client: input.identity.sessionClient,
          deliveryMode: "hook_poll",
          externalSessionId: input.identity.externalSessionId,
          externalThreadId: input.identity.externalThreadId,
        });
        if (head) throw new Error("hook_ticket_bundle_missing_for_existing_lineage");
        record = createInitialTicketRecord(input.identity, {
          controlToken: bearer(),
          captureToken: bearer(),
          now: this.now().toISOString(),
        });
        transaction.save(record);
      }
      if (record.state === "CLOSING") {
        if (!record.active) throw new Error("hook_ticket_closing_without_active_bundle");
        return record.active;
      }
      if (record.state === "DRAINING") {
        record = nextTicketRecord(record, { state: "ACTIVE" }, this.now().toISOString());
        transaction.save(record);
      }
      if (record.active && !record.pending) {
        exactActiveBundle(record, record.active);
        if (remainingTicketMs(record.active, this.now()) <= this.replacementWindowMs) {
          if (input.beforeReplacement) {
            const replay = await input.beforeReplacement({
              client: this.baseClient.withToken(record.active.capture.rawToken),
              binding: {
                hubSessionId: record.active.binding.hubSessionId,
                bundleId: record.active.bundleId,
                captureOfferId: record.active.capture.offerId,
              },
            });
            if (replay !== "DRAINED") {
              throw new Error("hook_ticket_terminal_capture_replay_pending");
            }
          }
          const pending = createReplacementPendingBundle(record, {
            controlToken: bearer(),
            captureToken: bearer(),
          });
          record = nextTicketRecord(
            record,
            { state: "REPLACING", pending },
            this.now().toISOString(),
          );
          transaction.save(record);
        } else {
          return record.active;
        }
      }
      if (!record.pending) throw new Error("hook_ticket_pending_bundle_missing");
      const pending = record.pending;
      const controlOfferClient =
        pending.activationMode === "FIRST_LINEAGE"
          ? this.agentBootstrap
          : this.baseClient.withToken(record.active!.control.rawToken);
      if (!pending.control.offerId) {
        let offered: SessionTicketOffer;
        try {
          offered = await controlOfferClient.createSessionTicketOffer(
            input.identity.projectId,
            offerInput(input.identity, pending, "CONTROL"),
          );
        } catch (error) {
          stableOfferReceiptError(error);
        }
        exactOfferReceipt(input.identity, pending, "CONTROL", offered, this.now());
        const updatedPending = {
          ...pending,
          control: { ...pending.control, offerId: offered.id },
        };
        record = nextTicketRecord(record, { pending: updatedPending }, this.now().toISOString());
        transaction.save(record);
      }
      if (!record.pending!.capture.offerId) {
        let offered: SessionTicketOffer;
        try {
          offered = await this.captureBootstrap.createSessionTicketOffer(
            input.identity.projectId,
            offerInput(input.identity, record.pending!, "CAPTURE"),
          );
        } catch (error) {
          stableOfferReceiptError(error);
        }
        exactOfferReceipt(input.identity, record.pending!, "CAPTURE", offered, this.now());
        const updatedPending = {
          ...record.pending!,
          capture: { ...record.pending!.capture, offerId: offered.id },
        };
        record = nextTicketRecord(record, { pending: updatedPending }, this.now().toISOString());
        transaction.save(record);
      }
      const ready = record.pending!;
      if (!ready.control.offerId || !ready.capture.offerId) {
        throw new Error("hook_ticket_offer_receipt_missing");
      }
      const pendingControl = this.baseClient.withToken(ready.control.rawToken);
      const result = await pendingControl.registerAdapterSession(input.identity.projectId, {
        agentId: input.identity.agentId,
        role: "primary",
        client: input.identity.sessionClient,
        transport: "hook-poll",
        deliveryMode: "hook_poll",
        externalSessionId: input.identity.externalSessionId,
        externalThreadId: input.identity.externalThreadId,
        host: hostname(),
        pid: process.ppid || process.pid,
        cwd: input.cwd,
        capabilities: ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"],
        expectedHeadSessionId: ready.expectedHeadSessionId,
        ticket_bundle_id: ready.bundleId,
        idempotencyKey: ready.registerIdempotencyKey,
      });
      const nextActive: HookActiveTicketBundle = {
        ...ready,
        control: { ...ready.control, offerId: ready.control.offerId },
        capture: { ...ready.capture, offerId: ready.capture.offerId },
        session: result.session,
        binding: result.ticketBinding,
        serverNow: result.serverNow,
        observedAt: this.now().toISOString(),
      };
      const activated = nextTicketRecord(
        record,
        { state: "ACTIVE", active: nextActive, pending: null },
        this.now().toISOString(),
      );
      exactActiveBundle(activated, nextActive);
      transaction.save(activated);
      return nextActive;
    });
    return this.runtime(input.identity, active);
  }

  private runtime(
    identity: HookTicketSessionIdentity,
    active: HookActiveTicketBundle,
  ): HookSessionRuntime {
    // Rebuild all post-registration clients from the exact active tickets. Neither bootstrap client
    // is returned or captured by runner.ts.
    const controlClient = this.baseClient.withToken(active.control.rawToken);
    const captureClient = this.baseClient.withToken(active.capture.rawToken);
    const receiptClient = this.receiptBaseClient.withToken(active.control.rawToken);
    return {
      identity,
      session: active.session,
      controlClient,
      captureClient,
      captureBinding: {
        hubSessionId: active.binding.hubSessionId,
        bundleId: active.bundleId,
        captureOfferId: active.capture.offerId,
      },
      receiptClient,
      ticketExpiresAt: active.binding.expiresAt,
      markDraining: async () => {
        await this.store.withRecord(identity, (transaction) => {
          const current = transaction.current;
          if (!current?.active || current.active.bundleId !== active.bundleId) {
            throw new Error("hook_ticket_drain_binding_changed");
          }
          if (current.state === "DRAINING") return;
          transaction.save(
            nextTicketRecord(current, { state: "DRAINING" }, this.now().toISOString()),
          );
        });
      },
      close: async (reason) => {
        await this.store.withRecord(identity, async (transaction) => {
          let current = transaction.current;
          if (!current?.active || current.active.bundleId !== active.bundleId) {
            throw new Error("hook_ticket_close_binding_changed");
          }
          if (current.pending) throw new Error("hook_ticket_close_replacement_in_progress");
          if (current.state !== "CLOSING") {
            current = nextTicketRecord(current, { state: "CLOSING" }, this.now().toISOString());
            transaction.save(current);
          }
          const currentActive = current.active;
          if (!currentActive) throw new Error("hook_ticket_close_active_missing");
          const exactControl = this.baseClient.withToken(currentActive.control.rawToken);
          const result = await exactControl.closeAdapterSession(currentActive.session.id, {
            reason,
            idempotencyKey: current.closeIdempotencyKey,
          });
          transaction.remove({
            bundleId: result.ticketBinding.bundleId,
            hubSessionId: result.ticketBinding.hubSessionId,
            state: result.ticketBinding.state,
            terminalAt: result.ticketBinding.terminalAt,
          });
        });
      },
    };
  }
}
