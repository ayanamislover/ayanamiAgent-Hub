import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const IdentitySchema = z
  .object({
    schemaVersion: z.literal(1),
    installationId: z.string().regex(/^cci_[A-Za-z0-9_-]{24,}$/u),
    createdAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export type ClaudeChannelInstallationIdentity = z.infer<typeof IdentitySchema>;

async function readIdentity(path: string): Promise<ClaudeChannelInstallationIdentity> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`Claude Channel installation identity must be a regular file: ${path}`);
  }
  await chmod(path, 0o600);
  try {
    return IdentitySchema.parse(JSON.parse(await readFile(path, "utf8")) as unknown);
  } catch (error) {
    throw new Error(`Invalid Claude Channel installation identity at ${path}`, { cause: error });
  }
}

/**
 * Creates one durable logical Channel identity. The value identifies an installation slot, not a
 * process, so a clean restart enters the same Hub lineage while two explicitly separate slots can
 * still coexist in one project.
 */
export async function loadOrCreateClaudeChannelIdentity(
  path: string,
): Promise<ClaudeChannelInstallationIdentity> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const identity: ClaudeChannelInstallationIdentity = {
    schemaVersion: 1,
    installationId: `cci_${randomBytes(24).toString("base64url")}`,
    createdAt: new Date().toISOString(),
  };
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(identity)}\n`, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    await handle?.close();
  }
  return readIdentity(path);
}
