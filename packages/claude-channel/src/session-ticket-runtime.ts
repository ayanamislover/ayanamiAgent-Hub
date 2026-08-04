import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import type { HubClient } from "@crossagent/client";
import {
  RegisterAdapterSessionResultSchema,
  RotateAdapterSessionTicketsResultSchema,
  SessionTicketBindingSchema,
  createId,
  type AgentSession,
  type RegisterAdapterSessionInput,
  type RegisterAdapterSessionResult,
  type RotateAdapterSessionTicketsResult,
  type SessionTicketBinding,
  type SessionTicketOfferInput,
} from "@crossagent/protocol";
import { z } from "zod";

export type ClaudeTicketActivationMode =
  "FIRST_LINEAGE" | "CURRENT_HEAD_REPLACEMENT" | "MANAGED_RESERVATION" | "SESSION_AUXILIARY";

export type ClaudeSessionTicketContext = {
  projectId: string;
  runId: string;
  activationMode: ClaudeTicketActivationMode;
  externalSessionId: string;
  externalThreadId: string | null;
  expectedLineageId?: string;
  expectedHeadSessionId?: string;
  launchReservationId?: string;
  launchGeneration?: number;
};

export type StoredClaudeSessionTicketBundle = {
  bundleId: string;
  phase: "PREPARING" | "OFFERED" | "ACTIVATING" | "ACTIVE";
  context: ClaudeSessionTicketContext;
  rawControl: string;
  offerId: string | null;
  activationAttempted: boolean;
  binding: SessionTicketBinding | null;
  rotationReceipt: RotateAdapterSessionTicketsResult | null;
  serverNow: string | null;
  observedAt: string | null;
};

export type ClaudeSessionTicketVaultSnapshot = {
  schemaVersion: 1;
  current: StoredClaudeSessionTicketBundle | null;
  successor: StoredClaudeSessionTicketBundle | null;
};

export interface ClaudeSessionTicketVault {
  load(): Promise<ClaudeSessionTicketVaultSnapshot | null>;
  save(snapshot: ClaudeSessionTicketVaultSnapshot): Promise<void>;
}

const ContextSchema = z
  .object({
    projectId: z.string().min(4),
    runId: z.string().min(4),
    activationMode: z.enum([
      "FIRST_LINEAGE",
      "CURRENT_HEAD_REPLACEMENT",
      "MANAGED_RESERVATION",
      "SESSION_AUXILIARY",
    ]),
    externalSessionId: z.string().min(1),
    externalThreadId: z.string().min(1).nullable(),
    expectedLineageId: z.string().min(4).optional(),
    expectedHeadSessionId: z.string().min(4).optional(),
    launchReservationId: z.string().min(4).optional(),
    launchGeneration: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((context, refinement) => {
    const lineage = context.expectedLineageId !== undefined;
    const head = context.expectedHeadSessionId !== undefined;
    const reservation = context.launchReservationId !== undefined;
    const generation = context.launchGeneration !== undefined;
    if (context.activationMode === "FIRST_LINEAGE") {
      if (lineage || head || reservation || generation) {
        refinement.addIssue({
          code: "custom",
          message: "FIRST_LINEAGE cannot carry replacement proof",
        });
      }
    } else if (context.activationMode === "MANAGED_RESERVATION") {
      if (!lineage || !head || !reservation || !generation) {
        refinement.addIssue({
          code: "custom",
          message: "MANAGED_RESERVATION requires its exact launch proof",
        });
      }
    } else {
      if (!lineage || !head || reservation || generation) {
        refinement.addIssue({
          code: "custom",
          message: `${context.activationMode} requires current-head proof only`,
        });
      }
    }
  });

const StoredBundleSchema = z
  .object({
    bundleId: z.string().min(4),
    phase: z.enum(["PREPARING", "OFFERED", "ACTIVATING", "ACTIVE"]),
    context: ContextSchema,
    rawControl: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    offerId: z.string().min(4).nullable(),
    activationAttempted: z.boolean(),
    binding: SessionTicketBindingSchema.nullable(),
    rotationReceipt: RotateAdapterSessionTicketsResultSchema.nullable(),
    serverNow: z.iso.datetime({ offset: true }).nullable(),
    observedAt: z.iso.datetime({ offset: true }).nullable(),
  })
  .strict()
  .superRefine((bundle, refinement) => {
    const active = bundle.phase === "ACTIVE";
    if (active !== (bundle.binding !== null)) {
      refinement.addIssue({
        code: "custom",
        path: ["binding"],
        message: "only ACTIVE bundles carry a binding",
      });
    }
    if (active !== (bundle.serverNow !== null && bundle.observedAt !== null)) {
      refinement.addIssue({
        code: "custom",
        path: ["serverNow"],
        message: "only ACTIVE bundles carry the fresh Hub clock observation",
      });
    }
    if (
      bundle.binding &&
      (bundle.binding.bundleId !== bundle.bundleId ||
        bundle.binding.projectId !== bundle.context.projectId ||
        bundle.binding.runId !== bundle.context.runId ||
        bundle.binding.agentId !== "claude" ||
        bundle.binding.adapterClient !== "claude" ||
        bundle.binding.purposes.length !== 1 ||
        bundle.binding.purposes[0]?.purpose !== "CONTROL")
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["binding"],
        message: "stored binding differs from the CONTROL bundle",
      });
    }
    if (
      bundle.rotationReceipt &&
      (!bundle.binding || bundle.rotationReceipt.ticketBinding.bundleId !== bundle.binding.bundleId)
    ) {
      refinement.addIssue({
        code: "custom",
        path: ["rotationReceipt"],
        message: "rotation receipt differs from the ACTIVE bundle",
      });
    }
  });

const VaultSchema = z
  .object({
    schemaVersion: z.literal(1),
    current: StoredBundleSchema.nullable(),
    successor: StoredBundleSchema.nullable(),
  })
  .strict()
  .superRefine((snapshot, refinement) => {
    if (snapshot.successor && snapshot.current?.phase !== "ACTIVE") {
      refinement.addIssue({
        code: "custom",
        path: ["successor"],
        message: "a successor requires one durable ACTIVE predecessor",
      });
    }
    if (snapshot.current && snapshot.successor?.bundleId === snapshot.current.bundleId) {
      refinement.addIssue({
        code: "custom",
        path: ["successor", "bundleId"],
        message: "successor bundle must differ from current",
      });
    }
  });

async function assertRegularFile(path: string): Promise<void> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Claude Channel ticket vault must be a regular file: ${path}`);
  }
}

/** Durable 0600 vault for exact lost-response replay. Raw tickets never leave the Adapter process. */
export class FileClaudeSessionTicketVault implements ClaudeSessionTicketVault {
  constructor(readonly path: string) {}

  async load(): Promise<ClaudeSessionTicketVaultSnapshot | null> {
    try {
      await assertRegularFile(this.path);
      await chmod(this.path, 0o600);
      return VaultSchema.parse(JSON.parse(await readFile(this.path, "utf8")) as unknown);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      if (error instanceof z.ZodError || error instanceof SyntaxError) {
        throw new Error(`Invalid Claude Channel ticket vault at ${this.path}`, { cause: error });
      }
      throw error;
    }
  }

  async save(snapshot: ClaudeSessionTicketVaultSnapshot): Promise<void> {
    const parsed = VaultSchema.parse(structuredClone(snapshot));
    const parent = dirname(this.path);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    await chmod(parent, 0o700);
    try {
      await assertRegularFile(this.path);
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = `${this.path}.${randomBytes(12).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    let renamed = false;
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.path);
      renamed = true;
      await chmod(this.path, 0o600);
      try {
        const directory = await open(parent, "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } catch {
        // Windows cannot fsync a directory handle; the atomic file replace remains the boundary.
      }
    } finally {
      if (!renamed) await unlink(temporary).catch(() => undefined);
    }
  }
}

type TicketControlHub = HubClient;

type TicketBootstrapHub = Pick<HubClient, "createSessionTicketOffer" | "withToken">;
type TicketOffererHub = Pick<HubClient, "createSessionTicketOffer">;

export type ActiveClaudeSessionTicketBundle = {
  stored: StoredClaudeSessionTicketBundle & { phase: "ACTIVE"; binding: SessionTicketBinding };
  /** Kept private to the Channel process; never serialize this projection. */
  rawControl: string;
  controlHub: TicketControlHub;
};

type RuntimeOptions = {
  bootstrapHub: TicketBootstrapHub;
  vault: ClaudeSessionTicketVault;
  now?: () => Date;
};

function digest(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function contextMatches(a: ClaudeSessionTicketContext, b: ClaudeSessionTicketContext): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Owns CONTROL-only ticket generation, durable ambiguity and exact activation/rotation replay. */
export class ClaudeSessionTicketRuntime {
  private snapshot: ClaudeSessionTicketVaultSnapshot | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: RuntimeOptions) {
    this.now = options.now ?? (() => new Date());
  }

  async prepareInitial(
    context: Exclude<ClaudeSessionTicketContext, { activationMode: "SESSION_AUXILIARY" }>,
  ): Promise<StoredClaudeSessionTicketBundle> {
    if (context.activationMode === "SESSION_AUXILIARY") {
      throw new Error("Initial Claude ticket enrollment cannot use SESSION_AUXILIARY");
    }
    const snapshot = await this.load();
    let bundle = snapshot.successor ?? snapshot.current;
    if (bundle) {
      if (!contextMatches(bundle.context, context)) {
        if (bundle.phase !== "ACTIVE") {
          throw new Error("Persisted Claude ticket attempt belongs to another launch binding");
        }
        bundle = this.createBundle(context);
        snapshot.successor = bundle;
        await this.persist();
      } else if (bundle.phase === "ACTIVE") {
        return structuredClone(bundle);
      }
    } else {
      bundle = this.createBundle(context);
      snapshot.current = bundle;
      await this.persist();
    }
    const offerer =
      context.activationMode === "CURRENT_HEAD_REPLACEMENT"
        ? this.currentActiveProjection().controlHub
        : this.options.bootstrapHub;
    await this.offer(bundle, offerer);
    return structuredClone(bundle);
  }

  async registerInitial(
    input: Omit<RegisterAdapterSessionInput, "projectId" | "ticket_bundle_id">,
  ): Promise<{
    registration: RegisterAdapterSessionResult;
    active: ActiveClaudeSessionTicketBundle;
  }> {
    const snapshot = await this.load();
    const bundle = snapshot.successor ?? snapshot.current;
    if (!bundle || !["OFFERED", "ACTIVATING"].includes(bundle.phase)) {
      throw new Error("No fully offered Claude CONTROL bundle is ready for registration");
    }
    bundle.phase = "ACTIVATING";
    bundle.activationAttempted = true;
    await this.persist();
    const controlHub = this.controlHub(bundle.rawControl);
    const registration = RegisterAdapterSessionResultSchema.parse(
      await controlHub.registerAdapterSession(bundle.context.projectId, {
        ...input,
        ticket_bundle_id: bundle.bundleId,
      }),
    );
    this.assertActivated(bundle, registration);
    bundle.phase = "ACTIVE";
    bundle.binding = registration.ticketBinding;
    bundle.serverNow = registration.serverNow;
    bundle.observedAt = this.now().toISOString();
    snapshot.current = bundle;
    snapshot.successor = null;
    await this.persist();
    return { registration, active: this.activeProjection(bundle) };
  }

  async activateSuccessor(
    currentSession: AgentSession,
    operationId: string,
  ): Promise<{
    rotation: RotateAdapterSessionTicketsResult;
    previous: ActiveClaudeSessionTicketBundle;
    next: ActiveClaudeSessionTicketBundle;
  }> {
    const snapshot = await this.load();
    const current = snapshot.current;
    if (!current || current.phase !== "ACTIVE" || !current.binding) {
      throw new Error("Claude CONTROL renewal requires one durable ACTIVE bundle");
    }
    this.assertSessionBinding(current, currentSession);
    const previous = this.activeProjection(current);
    const context: ClaudeSessionTicketContext = {
      projectId: current.binding.projectId,
      runId: current.binding.runId,
      activationMode: "SESSION_AUXILIARY",
      externalSessionId: currentSession.externalSessionId!,
      externalThreadId: currentSession.externalThreadId,
      expectedLineageId: current.binding.lineageId!,
      expectedHeadSessionId: current.binding.hubSessionId,
    };
    let successor = snapshot.successor;
    if (!successor) {
      successor = this.createBundle(context);
      snapshot.successor = successor;
      await this.persist();
    } else if (!contextMatches(successor.context, context)) {
      throw new Error("Persisted Claude CONTROL successor belongs to another session binding");
    }
    if (successor.phase !== "ACTIVE") {
      await this.offer(successor, previous.controlHub);
      successor.phase = "ACTIVATING";
      successor.activationAttempted = true;
      await this.persist();
      const rotation = RotateAdapterSessionTicketsResultSchema.parse(
        await previous.controlHub.rotateAdapterSessionTickets(
          current.binding.hubSessionId,
          successor.bundleId,
          { idempotencyKey: operationId },
        ),
      );
      this.assertRotation(current, successor, rotation);
      successor.phase = "ACTIVE";
      successor.binding = rotation.ticketBinding;
      successor.rotationReceipt = rotation;
      successor.serverNow = rotation.serverNow;
      successor.observedAt = this.now().toISOString();
      await this.persist();
      return { rotation, previous, next: this.activeProjection(successor) };
    }
    if (!successor.rotationReceipt || !successor.binding) {
      throw new Error("ACTIVE Claude successor lacks its exact rotation receipt");
    }
    this.assertRotation(current, successor, successor.rotationReceipt);
    return {
      rotation: structuredClone(successor.rotationReceipt),
      previous,
      next: this.activeProjection(successor),
    };
  }

  async commitSuccessor(bundleId: string): Promise<void> {
    const snapshot = await this.load();
    const successor = snapshot.successor;
    if (
      !successor ||
      successor.bundleId !== bundleId ||
      successor.phase !== "ACTIVE" ||
      !successor.binding
    ) {
      throw new Error("Only the durable ACTIVE Claude successor can become current");
    }
    snapshot.current = successor;
    snapshot.successor = null;
    await this.persist();
  }

  async currentActive(): Promise<ActiveClaudeSessionTicketBundle | null> {
    const current = (await this.load()).current;
    return current?.phase === "ACTIVE" && current.binding ? this.activeProjection(current) : null;
  }

  async pendingEnrollment(): Promise<StoredClaudeSessionTicketBundle | null> {
    const snapshot = await this.load();
    const candidate = snapshot.successor ?? snapshot.current;
    if (
      !candidate ||
      candidate.phase === "ACTIVE" ||
      candidate.context.activationMode === "SESSION_AUXILIARY"
    ) {
      return null;
    }
    return structuredClone(candidate);
  }

  async discardNonActiveEnrollment(bundleId: string): Promise<void> {
    const snapshot = await this.load();
    const candidate = snapshot.successor ?? snapshot.current;
    if (!candidate || candidate.bundleId !== bundleId || candidate.phase === "ACTIVE") {
      throw new Error("Only the exact non-active Claude enrollment may be discarded");
    }
    if (snapshot.successor?.bundleId === bundleId) snapshot.successor = null;
    if (snapshot.current?.bundleId === bundleId) snapshot.current = null;
    await this.persist();
  }

  /**
   * Forget one exact enrollment attempt after the Hub has rejected its credential.
   *
   * A CURRENT_HEAD_REPLACEMENT may have an ACTIVE predecessor plus a non-active successor. The
   * successor is authenticated by that predecessor, so a 401/403 means neither durable record may
   * be trusted for another launch. Clearing both is what permits a bootstrap FIRST_LINEAGE attempt;
   * accepting an arbitrary context here would turn a transient enrollment error into vault loss.
   */
  async discardRejectedEnrollment(context: ClaudeSessionTicketContext): Promise<void> {
    const snapshot = await this.load();
    const candidate = snapshot.successor ?? snapshot.current;
    if (!candidate || candidate.phase === "ACTIVE" || !contextMatches(candidate.context, context)) {
      throw new Error("Only the exact rejected Claude enrollment may be discarded");
    }
    snapshot.current = null;
    snapshot.successor = null;
    await this.persist();
  }

  /** Clear the exact ACTIVE lineage after a close receipt or direct credential rejection. */
  async discardActiveLineage(bundleId: string): Promise<void> {
    const snapshot = await this.load();
    const active = [snapshot.current, snapshot.successor].find(
      (bundle) => bundle?.bundleId === bundleId && bundle.phase === "ACTIVE",
    );
    if (!active) throw new Error("Only the exact ACTIVE Claude lineage may be discarded");
    snapshot.current = null;
    snapshot.successor = null;
    await this.persist();
  }

  private createBundle(context: ClaudeSessionTicketContext): StoredClaudeSessionTicketBundle {
    return {
      bundleId: createId("stb"),
      phase: "PREPARING",
      context: structuredClone(context),
      rawControl: randomBytes(32).toString("base64url"),
      offerId: null,
      activationAttempted: false,
      binding: null,
      rotationReceipt: null,
      serverNow: null,
      observedAt: null,
    };
  }

  private async offer(
    bundle: StoredClaudeSessionTicketBundle,
    offerer: TicketOffererHub,
  ): Promise<void> {
    if (bundle.phase === "ACTIVE" || bundle.offerId) return;
    const context = bundle.context;
    const input: SessionTicketOfferInput = {
      bundle_id: bundle.bundleId,
      purpose: "CONTROL",
      token_sha256: digest(bundle.rawControl),
      adapter_client: "claude",
      agent_id: "claude",
      session_client: "claude-channel",
      role: "primary",
      transport: "websocket",
      delivery_mode: "native_channel",
      external_session_id: context.externalSessionId,
      external_thread_id: context.externalThreadId,
      run_id: context.runId,
      activation_mode: context.activationMode,
      ...(context.expectedLineageId ? { expected_lineage_id: context.expectedLineageId } : {}),
      ...(context.expectedHeadSessionId
        ? { expected_head_session_id: context.expectedHeadSessionId }
        : {}),
      ...(context.launchReservationId
        ? { launch_reservation_id: context.launchReservationId }
        : {}),
      idempotency_key: `claude-ticket-offer:${bundle.bundleId}:CONTROL`,
    };
    const offered = await offerer.createSessionTicketOffer(context.projectId, input);
    bundle.offerId = offered.id;
    bundle.phase = "OFFERED";
    await this.persist();
  }

  private currentActiveProjection(): ActiveClaudeSessionTicketBundle {
    const current = this.snapshot?.current;
    if (!current || current.phase !== "ACTIVE" || !current.binding) {
      throw new Error("CURRENT_HEAD_REPLACEMENT requires the current durable CONTROL ticket");
    }
    return this.activeProjection(current);
  }

  private activeProjection(
    bundle: StoredClaudeSessionTicketBundle,
  ): ActiveClaudeSessionTicketBundle {
    if (bundle.phase !== "ACTIVE" || !bundle.binding)
      throw new Error("Claude ticket is not ACTIVE");
    return {
      stored: structuredClone(bundle) as ActiveClaudeSessionTicketBundle["stored"],
      rawControl: bundle.rawControl,
      controlHub: this.controlHub(bundle.rawControl),
    };
  }

  private controlHub(raw: string): TicketControlHub {
    return this.options.bootstrapHub.withToken(raw);
  }

  private assertActivated(
    bundle: StoredClaudeSessionTicketBundle,
    result: RegisterAdapterSessionResult,
  ): void {
    if (
      result.ticketBinding.bundleId !== bundle.bundleId ||
      result.ticketBinding.projectId !== bundle.context.projectId ||
      result.ticketBinding.hubSessionId !== result.session.id ||
      result.ticketBinding.runId !== bundle.context.runId ||
      result.ticketBinding.purposes.length !== 1 ||
      result.ticketBinding.purposes[0]?.purpose !== "CONTROL"
    ) {
      throw new Error("Hub activated Claude CONTROL outside the requested binding");
    }
  }

  private assertSessionBinding(
    bundle: StoredClaudeSessionTicketBundle,
    session: AgentSession,
  ): void {
    const binding = bundle.binding!;
    if (
      binding.hubSessionId !== session.id ||
      binding.projectId !== session.projectId ||
      binding.lineageId !== session.lineageId ||
      binding.incarnation !== session.incarnation ||
      binding.runId !== session.launcherRunId ||
      bundle.context.externalSessionId !== session.externalSessionId
    ) {
      throw new Error("Current Claude CONTROL no longer matches the live session lineage");
    }
  }

  private assertRotation(
    current: StoredClaudeSessionTicketBundle,
    successor: StoredClaudeSessionTicketBundle,
    result: RotateAdapterSessionTicketsResult,
  ): void {
    if (
      result.ticketBinding.bundleId !== successor.bundleId ||
      result.ticketBinding.hubSessionId !== current.binding!.hubSessionId ||
      result.ticketBinding.lineageId !== current.binding!.lineageId ||
      result.ticketBinding.incarnation !== current.binding!.incarnation ||
      result.ticketBinding.runId !== current.binding!.runId ||
      result.supersededTicketBinding.bundleId !== current.bundleId ||
      result.supersededTicketBinding.state !== "SUPERSEDED"
    ) {
      throw new Error("Hub returned a Claude CONTROL rotation outside the current binding");
    }
  }

  private async load(): Promise<ClaudeSessionTicketVaultSnapshot> {
    if (this.snapshot) return this.snapshot;
    this.snapshot = (await this.options.vault.load()) ?? {
      schemaVersion: 1,
      current: null,
      successor: null,
    };
    return this.snapshot;
  }

  private async persist(): Promise<void> {
    if (!this.snapshot) throw new Error("Claude ticket vault is not loaded");
    await this.options.vault.save(structuredClone(this.snapshot));
  }
}
