import { EventEmitter } from "node:events";
import type { DomainEvent } from "@crossagent/protocol";

export class EventBus {
  readonly #emitter = new EventEmitter();
  #websocketClients = 0;

  get websocketClients(): number {
    return this.#websocketClients;
  }

  connectWebSocket(): () => void {
    this.#websocketClients += 1;
    let connected = true;
    return () => {
      if (!connected) return;
      connected = false;
      this.#websocketClients = Math.max(0, this.#websocketClients - 1);
    };
  }

  publish(event: DomainEvent): void {
    this.#emitter.emit("event", event);
    this.#emitter.emit(`project:${event.projectId}`, event);
  }

  subscribe(projectId: string, listener: (event: DomainEvent) => void): () => void {
    const channel = `project:${projectId}`;
    this.#emitter.on(channel, listener);
    return () => this.#emitter.off(channel, listener);
  }
}
