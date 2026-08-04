import { describe, expect, it } from "vitest";
import { formatDashboardHash, parseDashboardHash } from "./navigation.js";

describe("Dashboard hash navigation", () => {
  it("round-trips the page, project, and task as one deep link", () => {
    const hash = formatDashboardHash({
      page: "communications",
      projectId: "prj_00example000000000000000000",
      taskId: "tsk_release-v1.0:final",
    });
    expect(hash).toBe(
      "#/communications?projectId=prj_00example000000000000000000&taskId=tsk_release-v1.0%3Afinal",
    );
    expect(parseDashboardHash(hash)).toEqual({
      page: "communications",
      projectId: "prj_00example000000000000000000",
      taskId: "tsk_release-v1.0:final",
    });
  });

  it("keeps legacy page-only hashes compatible", () => {
    expect(parseDashboardHash("#/reviews")).toEqual({
      page: "reviews",
      projectId: null,
      taskId: null,
    });
  });

  it("rejects padded, malformed, oversized, and orphaned route identities", () => {
    expect(parseDashboardHash("#/communications?projectId=%20prj_wrong&taskId=tsk_wrong")).toEqual({
      page: "communications",
      projectId: null,
      taskId: null,
    });
    expect(parseDashboardHash(`#/tasks?projectId=prj_ok&taskId=${"x".repeat(161)}`)).toEqual({
      page: "tasks",
      projectId: "prj_ok",
      taskId: null,
    });
    expect(parseDashboardHash("#/tasks?taskId=tsk_orphan")).toEqual({
      page: "tasks",
      projectId: null,
      taskId: null,
    });
  });

  it("falls back to overview without retaining unknown query state", () => {
    expect(parseDashboardHash("#/unknown?projectId=prj_ok&token=secret")).toEqual({
      page: "overview",
      projectId: "prj_ok",
      taskId: null,
    });
    expect(
      formatDashboardHash({ page: "overview", projectId: " invalid ", taskId: "tsk_ignored" }),
    ).toBe("#/overview");
  });
});
