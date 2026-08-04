import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { JsonLineRpcConnection } from "../src/rpc.js";

describe("JsonLineRpcConnection", () => {
  it("matches out-of-order responses and forwards notifications", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const connection = new JsonLineRpcConnection(fromServer, toServer);
    const sent: string[] = [];
    toServer.on("data", (chunk) => sent.push(String(chunk)));

    const first = connection.request("first");
    const second = connection.request("second");
    const notification = new Promise<string>((resolve) => {
      connection.once("notification", (message) => resolve(message.method));
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sent.join("")).toContain('"method":"first"');
    expect(sent.join("")).toContain('"method":"second"');

    fromServer.write('{"id":2,"result":{"value":"two"}}\n');
    fromServer.write('{"method":"turn/started","params":{"turn":{"id":"t1"}}}\n');
    fromServer.write('{"id":1,"result":{"value":"one"}}\n');

    await expect(first).resolves.toEqual({ value: "one" });
    await expect(second).resolves.toEqual({ value: "two" });
    await expect(notification).resolves.toBe("turn/started");
    connection.close();
  });

  it("rejects JSON-RPC errors with the wire code", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const connection = new JsonLineRpcConnection(fromServer, toServer);
    const pending = connection.request("turn/steer");
    fromServer.write('{"id":1,"error":{"code":-32602,"message":"expectedTurnId mismatch"}}\n');
    await expect(pending).rejects.toMatchObject({ code: -32602 });
    connection.close();
  });
});
