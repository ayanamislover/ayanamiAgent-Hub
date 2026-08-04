/* global process */
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let initialized = false;
let activeTurnId = null;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    initialized = true;
    send({
      id: message.id,
      result: {
        userAgent: "fake-codex/1.0",
        platformFamily: "windows",
        platformOs: "windows",
        authorityCredentialKeys: Object.keys(process.env).filter((key) =>
          /CROSSAGENT_(?:DASHBOARD|CAPTURE|INJECTOR)|CROSSAGENT_(?:CODEX|CLAUDE)_(?:CAPTURE|INJECTOR)/i.test(
            key,
          ),
        ),
      },
    });
    return;
  }
  if (message.method === "initialized") return;
  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: "Not initialized" } });
    return;
  }
  if (message.method === "model/list") {
    send({
      id: message.id,
      result: { data: [{ id: "fake-model", displayName: "Fake Model", isDefault: true }] },
    });
    return;
  }
  if (message.method === "thread/start" || message.method === "thread/resume") {
    const id = message.params.threadId ?? "thr_fake";
    send({ id: message.id, result: { thread: { id, sessionId: id } } });
    send({ method: "thread/started", params: { thread: { id } } });
    return;
  }
  if (message.method === "turn/start") {
    activeTurnId = "turn_fake";
    send({
      id: message.id,
      result: { turn: { id: activeTurnId, status: "inProgress", items: [], error: null } },
    });
    send({
      method: "turn/started",
      params: { threadId: message.params.threadId, turn: { id: activeTurnId } },
    });
    return;
  }
  if (message.method === "turn/steer") {
    if (message.params.expectedTurnId !== activeTurnId) {
      send({
        id: message.id,
        error: { code: -32602, message: "expectedTurnId mismatch" },
      });
      return;
    }
    send({ id: message.id, result: { turnId: activeTurnId } });
    return;
  }
  if (message.method === "thread/inject_items") {
    send({ id: message.id, result: {} });
    return;
  }
  send({ id: message.id, error: { code: -32601, message: "Method not found" } });
});
