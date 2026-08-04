import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  ReleaseLayout,
  ReleaseLayoutError,
  type ReleaseContentIdentity,
  type ReleaseContentVerifier,
  type ReleaseDescriptor,
  type ReleaseLayoutLease,
  type ReleaseOperationHandle,
} from "../src/release-layout.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeWritable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function makeWritable(path: string): void {
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return;
  if (stat.isDirectory()) {
    chmodSync(path, 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else {
    chmodSync(path, 0o600);
  }
}

class MemoryLease implements ReleaseLayoutLease {
  private tail = Promise.resolve();
  active = 0;
  maxActive = 0;

  async withLease<T>(
    _input: { leaseName: string; ownerId: string },
    work: () => Promise<T>,
  ): Promise<T> {
    const before = this.tail;
    let release: () => void = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      return await work();
    } finally {
      this.active -= 1;
      release();
    }
  }
}

const verifier: ReleaseContentVerifier = {
  async verify(releaseRoot) {
    const identity = JSON.parse(
      readFileSync(join(releaseRoot, "release-identity.json"), "utf8"),
    ) as ReleaseContentIdentity;
    const payload = readFileSync(join(releaseRoot, "payload.bin"));
    if (createHash("sha256").update(payload).digest("hex") !== identity.buildId) {
      throw new Error("payload hash mismatch");
    }
    const manifest = readFileSync(join(releaseRoot, "release-manifest.json"));
    if (createHash("sha256").update(manifest).digest("hex") !== identity.manifestSha256) {
      throw new Error("manifest hash mismatch");
    }
    return identity;
  },
};

function fixture(
  payload: string,
  sessionId: string,
): ReleaseContentIdentity & { payload: string; manifest: string } {
  const buildId = createHash("sha256").update(payload).digest("hex");
  const manifest = JSON.stringify({
    schemaVersion: 1,
    buildId,
    files: [{ path: "payload.bin", sha256: buildId }],
  });
  return {
    payload,
    manifest,
    buildId,
    buildSessionId: sessionId,
    protocolId: "2".repeat(64),
    migrationId: "3".repeat(64),
    manifestSha256: createHash("sha256").update(manifest).digest("hex"),
  };
}

function createLayout(
  root: string,
  lease = new MemoryLease(),
  ownerId = "owner_layout_test",
): ReleaseLayout {
  return new ReleaseLayout({
    dataDir: join(root, "data"),
    ownerId,
    lease,
    verifier,
    now: () => "2026-08-01T12:00:00.000Z",
  });
}

function descriptorFor(layout: ReleaseLayout, item: ReleaseContentIdentity): ReleaseDescriptor {
  return {
    buildId: item.buildId,
    buildSessionId: item.buildSessionId,
    protocolId: item.protocolId,
    migrationId: item.migrationId,
    manifestSha256: item.manifestSha256,
    releaseRoot: layout.releaseRoot(item.buildSessionId),
  };
}

async function materialize(
  layout: ReleaseLayout,
  item: ReleaseContentIdentity & { payload: string; manifest: string },
): Promise<ReleaseDescriptor> {
  const descriptor = descriptorFor(layout, item);
  return layout.createRelease(descriptor, async (stagingRoot) => {
    writeFileSync(join(stagingRoot, "payload.bin"), item.payload);
    writeFileSync(join(stagingRoot, "release-manifest.json"), item.manifest);
    writeFileSync(
      join(stagingRoot, "release-identity.json"),
      JSON.stringify({
        buildId: item.buildId,
        buildSessionId: item.buildSessionId,
        protocolId: item.protocolId,
        migrationId: item.migrationId,
        manifestSha256: item.manifestSha256,
      }),
    );
  });
}

function expectCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ReleaseLayoutError && error.code === code;
}

describe("immutable release roots", () => {
  it("materializes, verifies, seals, and idempotently reuses the exact release root", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-layout-"));
    roots.push(root);
    const layout = createLayout(root);
    const item = fixture("candidate-one", "11111111-1111-4111-8111-111111111111");
    const descriptor = await materialize(layout, item);

    expect(descriptor.releaseRoot).toBe(
      join(root, "data", "releases", "11111111-1111-4111-8111-111111111111"),
    );
    expect(await layout.verifyRelease(descriptor)).toEqual(descriptor);
    expect(readdirSync(join(root, "data", "releases"))).toEqual([item.buildSessionId]);
    if (process.platform !== "win32") {
      expect(lstatSync(descriptor.releaseRoot).mode & 0o777).toBe(0o500);
      expect(lstatSync(join(descriptor.releaseRoot, "payload.bin")).mode & 0o777).toBe(0o400);
    }

    let called = false;
    await layout.createRelease(descriptor, async () => {
      called = true;
    });
    expect(called).toBe(false);

    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o600);
    writeFileSync(join(descriptor.releaseRoot, "release-manifest.json"), "manifest-drift");
    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o400);
    await expect(layout.verifyRelease(descriptor)).rejects.toSatisfy(
      expectCode("CONTENT_VERIFICATION_FAILED"),
    );
    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o600);
    writeFileSync(join(descriptor.releaseRoot, "release-manifest.json"), item.manifest);
    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o400);

    const driftedManifest = "coordinated-manifest-drift";
    const driftedManifestSha256 = createHash("sha256").update(driftedManifest).digest("hex");
    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o600);
    writeFileSync(join(descriptor.releaseRoot, "release-manifest.json"), driftedManifest);
    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o400);
    chmodSync(join(descriptor.releaseRoot, "release-identity.json"), 0o600);
    writeFileSync(
      join(descriptor.releaseRoot, "release-identity.json"),
      JSON.stringify({
        buildId: item.buildId,
        buildSessionId: item.buildSessionId,
        protocolId: item.protocolId,
        migrationId: item.migrationId,
        manifestSha256: driftedManifestSha256,
      }),
    );
    chmodSync(join(descriptor.releaseRoot, "release-identity.json"), 0o400);
    await expect(layout.verifyRelease(descriptor)).rejects.toSatisfy(
      expectCode("CONTENT_IDENTITY_MISMATCH"),
    );

    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o600);
    writeFileSync(join(descriptor.releaseRoot, "release-manifest.json"), item.manifest);
    chmodSync(join(descriptor.releaseRoot, "release-manifest.json"), 0o400);
    chmodSync(join(descriptor.releaseRoot, "release-identity.json"), 0o600);
    writeFileSync(
      join(descriptor.releaseRoot, "release-identity.json"),
      JSON.stringify({
        buildId: item.buildId,
        buildSessionId: item.buildSessionId,
        protocolId: item.protocolId,
        migrationId: item.migrationId,
        manifestSha256: item.manifestSha256,
      }),
    );
    chmodSync(join(descriptor.releaseRoot, "release-identity.json"), 0o400);

    chmodSync(join(descriptor.releaseRoot, "payload.bin"), 0o600);
    writeFileSync(join(descriptor.releaseRoot, "payload.bin"), "tampered");
    chmodSync(join(descriptor.releaseRoot, "payload.bin"), 0o400);
    await expect(layout.verifyRelease(descriptor)).rejects.toSatisfy(
      expectCode("CONTENT_VERIFICATION_FAILED"),
    );
  });

  it("rejects non-exact metadata, path traversal, the wrong root, and secret fields", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-layout-invalid-"));
    roots.push(root);
    const layout = createLayout(root);
    const item = fixture("candidate-two", "22222222-2222-4222-8222-222222222222");
    const exact = descriptorFor(layout, item);

    const { manifestSha256: _manifestSha256, ...legacyDescriptor } = exact;
    await expect(
      layout.createRelease(legacyDescriptor as ReleaseDescriptor, async () => {}),
    ).rejects.toSatisfy(expectCode("DESCRIPTOR_INVALID"));

    await expect(
      layout.createRelease(
        { ...exact, token: "Bearer forged" } as ReleaseDescriptor,
        async () => {},
      ),
    ).rejects.toSatisfy(expectCode("DESCRIPTOR_INVALID"));
    await expect(
      layout.createRelease(
        { ...exact, buildSessionId: "../escape" } as ReleaseDescriptor,
        async () => {},
      ),
    ).rejects.toSatisfy(expectCode("DESCRIPTOR_INVALID"));
    await expect(
      layout.createRelease({ ...exact, releaseRoot: join(root, "elsewhere") }, async () => {}),
    ).rejects.toSatisfy(expectCode("RELEASE_ROOT_MISMATCH"));

    const forgedVerifierLayout = new ReleaseLayout({
      dataDir: join(root, "forged-data"),
      ownerId: "owner_forged_verifier",
      lease: new MemoryLease(),
      verifier: {
        async verify() {
          return { ...item, credential: "must-not-be-persisted" } as ReleaseContentIdentity;
        },
      },
    });
    const forgedDescriptor = descriptorFor(forgedVerifierLayout, item);
    await expect(
      forgedVerifierLayout.createRelease(forgedDescriptor, async (stagingRoot) => {
        writeFileSync(join(stagingRoot, "payload.bin"), item.payload);
      }),
    ).rejects.toSatisfy(expectCode("CONTENT_VERIFICATION_FAILED"));
    expect(existsSync(forgedDescriptor.releaseRoot)).toBe(false);
  });

  it("rejects symlinks or junctions anywhere in a candidate tree", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-layout-link-"));
    roots.push(root);
    const layout = createLayout(root);
    const item = fixture("candidate-link", "33333333-3333-4333-8333-333333333333");
    const external = join(root, "external");
    mkdirSync(external);
    const descriptor = descriptorFor(layout, item);

    await expect(
      layout.createRelease(descriptor, async (stagingRoot) => {
        writeFileSync(join(stagingRoot, "payload.bin"), item.payload);
        writeFileSync(join(stagingRoot, "release-manifest.json"), item.manifest);
        writeFileSync(
          join(stagingRoot, "release-identity.json"),
          JSON.stringify({
            buildId: item.buildId,
            buildSessionId: item.buildSessionId,
            protocolId: item.protocolId,
            migrationId: item.migrationId,
            manifestSha256: item.manifestSha256,
          }),
        );
        symlinkSync(external, join(stagingRoot, "escaped"), "junction");
      }),
    ).rejects.toSatisfy(expectCode("UNSAFE_RELEASE_TREE"));
  });

  it("rejects a symlinked data root before reading or writing metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-layout-root-link-"));
    roots.push(root);
    const real = join(root, "real-data");
    const linked = join(root, "linked-data");
    mkdirSync(real);
    symlinkSync(real, linked, "junction");
    const layout = new ReleaseLayout({
      dataDir: linked,
      ownerId: "owner_link_test",
      lease: new MemoryLease(),
      verifier,
    });
    await expect(layout.readCurrent()).rejects.toSatisfy(expectCode("UNSAFE_DATA_DIR"));
  });
});

describe("persistent release operation and current pointer", () => {
  it("serializes two processes, rejects two active operations, and survives re-instantiation", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-operation-"));
    roots.push(root);
    const lease = new MemoryLease();
    const first = createLayout(root, lease, "owner_first");
    const second = createLayout(root, lease, "owner_second");
    const candidate = await materialize(
      first,
      fixture("candidate-operation", "44444444-4444-4444-8444-444444444444"),
    );

    const results = await Promise.allSettled([
      first.beginOperation({
        operationId: "rel_first",
        expectedCurrentRevision: null,
        candidate,
      }),
      second.beginOperation({
        operationId: "rel_second",
        expectedCurrentRevision: null,
        candidate,
      }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(lease.maxActive).toBe(1);

    const winning = results.find(
      (result): result is PromiseFulfilledResult<ReleaseOperationHandle> =>
        result.status === "fulfilled",
    )!.value;
    const replayOwner = createLayout(
      root,
      lease,
      winning.operationId === "rel_first" ? "owner_first" : "owner_second",
    );
    expect(
      await replayOwner.beginOperation({
        operationId: winning.operationId,
        expectedCurrentRevision: null,
        candidate,
      }),
    ).toEqual(winning);
    await expect(
      first.beginOperation({
        operationId: "rel_third",
        expectedCurrentRevision: null,
        candidate,
      }),
    ).rejects.toSatisfy(expectCode("ACTIVE_OPERATION_EXISTS"));
  });

  it("uses revision CAS, makes activation replay-safe, and defeats stale-handle ABA", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-cas-"));
    roots.push(root);
    const lease = new MemoryLease();
    const layout = createLayout(root, lease);
    const releaseA = await materialize(
      layout,
      fixture("release-a", "55555555-5555-4555-8555-555555555555"),
    );
    const releaseB = await materialize(
      layout,
      fixture("release-b", "66666666-6666-4666-8666-666666666666"),
    );

    const handleA = await layout.beginOperation({
      operationId: "rel_a",
      expectedCurrentRevision: null,
      candidate: releaseA,
    });
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          operationId: "rel_a",
          expectedCurrentRevision: null,
          candidate: releaseA,
        }),
      )
      .digest("hex");
    const { manifestSha256: _manifestSha256, ...legacyReleaseA } = releaseA;
    const legacyFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          operationId: "rel_a",
          expectedCurrentRevision: null,
          candidate: legacyReleaseA,
        }),
      )
      .digest("hex");
    expect(handleA.requestFingerprint).toBe(expectedFingerprint);
    expect(handleA.requestFingerprint).not.toBe(legacyFingerprint);
    const currentA = await layout.activate(handleA);
    expect(currentA).toMatchObject({ revision: 1, operationId: "rel_a", descriptor: releaseA });
    expect(await layout.activate(handleA)).toEqual(currentA);
    await layout.complete(handleA);

    const resumedA = createLayout(root, lease);
    expect(
      await resumedA.beginOperation({
        operationId: "rel_a",
        expectedCurrentRevision: null,
        candidate: releaseA,
      }),
    ).toEqual(handleA);
    expect(await resumedA.activate(handleA)).toEqual(currentA);
    expect((await resumedA.complete(handleA)).state).toBe("COMPLETED");

    await expect(
      layout.beginOperation({
        operationId: "rel_stale",
        expectedCurrentRevision: 2,
        candidate: releaseB,
      }),
    ).rejects.toSatisfy(expectCode("STALE_POINTER_REVISION"));

    const handleB = await layout.beginOperation({
      operationId: "rel_b",
      expectedCurrentRevision: 1,
      candidate: releaseB,
    });
    await expect(layout.activate(handleA)).rejects.toSatisfy(expectCode("STALE_OPERATION"));
    const currentB = await layout.activate(handleB);
    expect(currentB).toMatchObject({ revision: 2, operationId: "rel_b", descriptor: releaseB });
    await layout.complete(handleB);

    const handleA2 = await layout.beginOperation({
      operationId: "rel_a",
      expectedCurrentRevision: 2,
      candidate: releaseA,
    });
    expect(handleA2.operationRevision).toBeGreaterThan(handleA.operationRevision);
    await expect(layout.complete(handleA)).rejects.toSatisfy(expectCode("STALE_OPERATION"));
    expect(await layout.activate(handleA2)).toMatchObject({ revision: 3, descriptor: releaseA });
  });

  it("rejects forged handles, secret-shaped operation input, and corrupt persisted metadata", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-metadata-"));
    roots.push(root);
    const layout = createLayout(root);
    const candidate = await materialize(
      layout,
      fixture("release-metadata", "77777777-7777-4777-8777-777777777777"),
    );

    await expect(
      layout.beginOperation({
        operationId: "rel_secret",
        expectedCurrentRevision: null,
        candidate,
        credential: "top-secret",
      } as never),
    ).rejects.toSatisfy(expectCode("OPERATION_INVALID"));

    const handle = await layout.beginOperation({
      operationId: "rel_valid",
      expectedCurrentRevision: null,
      candidate,
    });
    await expect(
      layout.activate({ ...handle, operationRevision: handle.operationRevision + 1 }),
    ).rejects.toSatisfy(expectCode("STALE_OPERATION"));

    writeFileSync(join(root, "data", "current-release.json"), '{"token":"forged"}');
    chmodSync(join(root, "data", "current-release.json"), 0o600);
    await expect(layout.readCurrent()).rejects.toSatisfy(expectCode("POINTER_CORRUPT"));
  });

  it("rejects legacy four-part control records and binds manifest hash into the fingerprint", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-legacy-"));
    roots.push(root);
    const layout = createLayout(root);
    const candidate = await materialize(
      layout,
      fixture("release-legacy", "99999999-9999-4999-8999-999999999999"),
    );
    const handle = await layout.beginOperation({
      operationId: "rel_legacy",
      expectedCurrentRevision: null,
      candidate,
    });
    await layout.activate(handle);

    const pointerPath = join(root, "data", "current-release.json");
    const pointer = JSON.parse(readFileSync(pointerPath, "utf8")) as {
      descriptor: Record<string, unknown>;
    };
    delete pointer.descriptor.manifestSha256;
    writeFileSync(pointerPath, JSON.stringify(pointer));
    chmodSync(pointerPath, 0o600);
    await expect(layout.readCurrent()).rejects.toSatisfy(expectCode("POINTER_CORRUPT"));

    const operationPath = join(root, "data", "release-operation.json");
    const originalOperation = JSON.parse(readFileSync(operationPath, "utf8")) as {
      candidate: Record<string, unknown>;
    };
    const legacyOperation = structuredClone(originalOperation);
    delete legacyOperation.candidate.manifestSha256;
    writeFileSync(operationPath, JSON.stringify(legacyOperation));
    chmodSync(operationPath, 0o600);
    await expect(layout.readOperation()).rejects.toSatisfy(expectCode("OPERATION_CORRUPT"));

    const driftedOperation = structuredClone(originalOperation);
    driftedOperation.candidate.manifestSha256 = "f".repeat(64);
    writeFileSync(operationPath, JSON.stringify(driftedOperation));
    chmodSync(operationPath, 0o600);
    await expect(layout.readOperation()).rejects.toSatisfy(expectCode("OPERATION_CORRUPT"));
  });

  it("writes owner-private control files with no abandoned same-directory temp files", async () => {
    const root = mkdtempSync(join(tmpdir(), "crossagent-release-private-"));
    roots.push(root);
    const layout = createLayout(root);
    const candidate = await materialize(
      layout,
      fixture("release-private", "88888888-8888-4888-8888-888888888888"),
    );
    const handle = await layout.beginOperation({
      operationId: "rel_private",
      expectedCurrentRevision: null,
      candidate,
    });
    await layout.activate(handle);
    await layout.complete(handle);

    const names = readdirSync(join(root, "data"));
    expect(names.filter((name) => name.includes(".tmp"))).toEqual([]);
    const pointer = JSON.parse(
      readFileSync(join(root, "data", "current-release.json"), "utf8"),
    ) as { descriptor: ReleaseDescriptor };
    const operation = JSON.parse(
      readFileSync(join(root, "data", "release-operation.json"), "utf8"),
    ) as { candidate: ReleaseDescriptor };
    expect(pointer.descriptor.manifestSha256).toBe(candidate.manifestSha256);
    expect(operation.candidate.manifestSha256).toBe(candidate.manifestSha256);
    if (process.platform !== "win32") {
      expect(lstatSync(join(root, "data", "current-release.json")).mode & 0o777).toBe(0o600);
      expect(lstatSync(join(root, "data", "release-operation.json")).mode & 0o777).toBe(0o600);
    }
  });
});
