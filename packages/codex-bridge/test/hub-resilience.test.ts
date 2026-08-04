import { describe, expect, it } from "vitest";
import { HubReconnectBackoff, isHubNetworkError } from "../src/hub-resilience.js";

describe("HubReconnectBackoff", () => {
  it("preserves the default 250/500/1000 exponential sequence at neutral jitter", () => {
    const backoff = new HubReconnectBackoff({ random: () => 0.5 });

    expect(Array.from({ length: 4 }, () => backoff.nextDelayMs())).toEqual([
      250, 500, 1_000, 2_000,
    ]);
  });

  it("backs off exponentially, stays capped, and resets after recovery", () => {
    const backoff = new HubReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0,
    });

    expect(Array.from({ length: 6 }, () => backoff.nextDelayMs())).toEqual([
      100, 200, 400, 800, 1_000, 1_000,
    ]);

    backoff.reset();
    expect(backoff.nextDelayMs()).toBe(100);
  });

  it("adds jitter without exceeding the configured cap", () => {
    const low = new HubReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.2,
      random: () => 0,
    });
    const high = new HubReconnectBackoff({
      initialDelayMs: 1_000,
      maxDelayMs: 1_000,
      jitterRatio: 0.2,
      random: () => 1,
    });

    expect(low.nextDelayMs()).toBe(80);
    expect(high.nextDelayMs()).toBe(1_000);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative value", -100],
  ])("falls back from an invalid initial delay: %s", (_label, initialDelayMs) => {
    const backoff = new HubReconnectBackoff({
      initialDelayMs,
      jitterRatio: 0,
    });

    expect(backoff.nextDelayMs()).toBe(250);
  });

  it.each([
    ["NaN", Number.NaN],
    ["positive infinity", Number.POSITIVE_INFINITY],
    ["zero", 0],
    ["a negative value", -100],
  ])("falls back from an invalid maximum delay: %s", (_label, maxDelayMs) => {
    const backoff = new HubReconnectBackoff({
      initialDelayMs: 4_000,
      maxDelayMs,
      jitterRatio: 0,
    });

    expect([backoff.nextDelayMs(), backoff.nextDelayMs()]).toEqual([4_000, 5_000]);
  });

  it("never returns a delay above Node's setTimeout maximum", () => {
    const nodeMaxTimerDelayMs = 2_147_483_647;
    const backoff = new HubReconnectBackoff({
      initialDelayMs: nodeMaxTimerDelayMs + 1_000,
      maxDelayMs: nodeMaxTimerDelayMs + 2_000,
      jitterRatio: 0,
    });

    expect([backoff.nextDelayMs(), backoff.nextDelayMs()]).toEqual([
      nodeMaxTimerDelayMs,
      nodeMaxTimerDelayMs,
    ]);
  });

  it("normalizes invalid jitter ratios without producing non-finite delays", () => {
    const invalid = new HubReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: Number.NaN,
      random: () => 0,
    });
    const negative = new HubReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: -1,
      random: () => 0,
    });
    const oversized = new HubReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 2,
      random: () => 1,
    });

    expect(invalid.nextDelayMs()).toBe(80);
    expect(negative.nextDelayMs()).toBe(100);
    expect(oversized.nextDelayMs()).toBe(200);
  });

  it.each([
    ["below zero", -10, 80],
    ["above one", 10, 120],
    ["NaN", Number.NaN, 100],
    ["positive infinity", Number.POSITIVE_INFINITY, 100],
    ["negative infinity", Number.NEGATIVE_INFINITY, 100],
  ])("clamps or neutralizes an invalid random output: %s", (_label, randomValue, expected) => {
    const backoff = new HubReconnectBackoff({
      initialDelayMs: 100,
      maxDelayMs: 1_000,
      jitterRatio: 0.2,
      random: () => randomValue,
    });

    expect(backoff.nextDelayMs()).toBe(expected);
  });
});

describe("isHubNetworkError", () => {
  it("recognizes fetch and nested socket failures without classifying HTTP errors", () => {
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });

    expect(isHubNetworkError(refused)).toBe(true);
    expect(
      isHubNetworkError(Object.assign(new Error("socket reset"), { code: "ECONNRESET" })),
    ).toBe(true);
    expect(isHubNetworkError(new Error("Hub request failed with HTTP 500"))).toBe(false);
  });

  it("recognizes DOM and plain-object abort or timeout errors as transient", () => {
    expect(isHubNetworkError(new DOMException("request aborted", "AbortError"))).toBe(true);
    expect(isHubNetworkError({ name: "TimeoutError", message: "request timed out" })).toBe(true);
    expect(isHubNetworkError({ name: "SyntaxError", message: "invalid payload" })).toBe(false);
  });
});
