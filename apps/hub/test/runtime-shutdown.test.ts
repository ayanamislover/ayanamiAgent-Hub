import { describe, expect, it, vi } from "vitest";
import { completeHubShutdown } from "../src/runtime/shutdown.js";

describe("Hub runtime shutdown completion", () => {
  it("does not publish a receipt or release the runtime lease when server close fails", async () => {
    const writeReceipt = vi.fn();
    const releaseLease = vi.fn();

    await expect(
      completeHubShutdown({
        close: async () => {
          throw new Error("close failed");
        },
        writeReceipt,
        releaseLease,
      }),
    ).rejects.toThrow("close failed");
    expect(writeReceipt).not.toHaveBeenCalled();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("keeps the runtime lease when durable receipt publication fails", async () => {
    const close = vi.fn(async () => undefined);
    const releaseLease = vi.fn();

    await expect(
      completeHubShutdown({
        close,
        writeReceipt: () => {
          throw new Error("receipt fsync failed");
        },
        releaseLease,
      }),
    ).rejects.toThrow("receipt fsync failed");
    expect(close).toHaveBeenCalledOnce();
    expect(releaseLease).not.toHaveBeenCalled();
  });

  it("releases only after close and optional durable receipt complete in order", async () => {
    const order: string[] = [];
    await completeHubShutdown({
      close: async () => {
        order.push("close");
      },
      writeReceipt: () => {
        order.push("receipt");
      },
      releaseLease: () => {
        order.push("release");
      },
    });
    expect(order).toEqual(["close", "receipt", "release"]);
  });
});
