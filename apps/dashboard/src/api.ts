import { HubClient } from "@crossagent/client";

export const hub = new HubClient({
  baseUrl: window.location.origin,
});

export function idempotency(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}
