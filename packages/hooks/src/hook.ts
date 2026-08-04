#!/usr/bin/env node
import { readFileSync } from "node:fs";
import {
  TrustedAuthorityKeyManifestSchema,
  type TrustedAuthorityKeyManifest,
} from "@crossagent/protocol";
import { executeHook, readHookInput, type HookClientKind } from "./runner.js";

function argument(name: string): string | undefined {
  const position = process.argv.indexOf(name);
  const value = position >= 0 ? process.argv[position + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function readCredential(path: string | undefined): string {
  if (!path) return "";
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    // Bootstrap credentials remain independent. Neither credential is a Hook data-plane fallback.
    return "";
  }
}

function readAuthorityTrustManifest(
  path: string | undefined,
): TrustedAuthorityKeyManifest | undefined {
  if (!path) return undefined;
  try {
    const parsed = TrustedAuthorityKeyManifestSchema.parse(
      JSON.parse(readFileSync(path, "utf8")) as unknown,
    );
    const frozen = {
      schemaVersion: parsed.schemaVersion,
      keys: parsed.keys.map((key) => Object.freeze({ ...key })),
    };
    Object.freeze(frozen.keys);
    return Object.freeze(frozen) as TrustedAuthorityKeyManifest;
  } catch {
    // Capture is an independent authority channel. A missing or corrupt trust root disables only
    // coordination; executeHook exposes that state in additionalContext instead of trusting live
    // keys or falling back to the shared bearer.
    return undefined;
  }
}

async function writeHookOutput(output: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.write(`${JSON.stringify(output)}\n`, (error) => {
      if (error) rejectWrite(error);
      else resolveWrite();
    });
  });
}

const index = process.argv.indexOf("--client");
const client = process.argv[index + 1] as HookClientKind | undefined;
if (!client || !["codex", "claude"].includes(client)) {
  process.stderr.write("crossagent-hook requires --client codex|claude\n");
  process.exitCode = 2;
} else {
  const input = await readHookInput();
  // Threat model: these persisted paths prevent configuration drift; they do not attest that stdin
  // came from Codex/Claude. A same-OS, same-user shell can invoke this executable and remains outside
  // the authority boundary until capture runs in an independently protected host adapter.
  const agentBootstrapToken = readCredential(argument("--agent-token-file"));
  const captureBootstrapToken = readCredential(argument("--capture-token-file"));
  const authorityTrustManifest = readAuthorityTrustManifest(argument("--authority-trust-file"));
  const execution = await executeHook(client, input, {
    // Static credentials only offer/enroll. executeHook exposes only exact session-bound clients.
    agentBootstrapToken,
    captureBootstrapToken,
    authorityTrustManifest,
    ticketStoreDir: argument("--ticket-store-dir"),
    spoolDir: argument("--spool-dir"),
    baseUrl: argument("--base-url"),
  });
  if (execution.coordinationErrors.length > 0) {
    // Only structured stage/code/provenance ids are logged; message/user text and credentials are
    // deliberately absent. This keeps fail-closed authority rejection observable without leaking
    // the content it refused to inject.
    process.stderr.write(
      `[crossagent] ${JSON.stringify({
        kind: "hook_coordination_errors",
        errors: execution.coordinationErrors,
      })}\n`,
    );
  }
  if (execution.deliveryReceipts.length > 0 && Object.keys(execution.output).length === 0) {
    await execution.finalizeDelivery("AMBIGUOUS", "hook_delivery_had_no_model_visible_output");
    throw new Error("CrossAgent Hook refused to confirm a delivery with no model-visible output");
  }
  if (Object.keys(execution.output).length > 0) {
    try {
      await writeHookOutput(execution.output);
      await execution.finalizeDelivery("DELIVERED");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        await execution.finalizeDelivery("AMBIGUOUS", message);
      } catch (finalizationError) {
        throw new AggregateError(
          [error, finalizationError],
          "CrossAgent Hook output and ambiguity finalization both failed",
        );
      }
      throw error;
    }
  }
}
