import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";

/**
 * The WebSocket section of the protocol document described a credential in the URL long after the
 * server started refusing one. `pnpm docs:check` makes every JSON example there declare which
 * schema it is an example of; this is the half that actually parses one against the other, because
 * only a test can import the schemas.
 */

const documentPath = resolve(import.meta.dirname, "../../../docs/protocol.md");
const document = readFileSync(documentPath, "utf8");

type DocumentedExample = { schema: string; line: number; json: string };

function documentedExamples(): DocumentedExample[] {
  const lines = document.split(/\r?\n/);
  const examples: DocumentedExample[] = [];
  let pending: { schema: string; line: number } | null = null;
  let collecting: string[] | null = null;

  for (const [index, line] of lines.entries()) {
    const annotation = /^<!--\s*schema:\s*(\S+)\s*-->$/u.exec(line.trim());
    if (annotation?.[1]) {
      pending = { schema: annotation[1], line: index + 1 };
      continue;
    }
    if (collecting) {
      if (line.trim() === "```") {
        const started = pending;
        if (started) examples.push({ ...started, json: collecting.join("\n") });
        collecting = null;
        pending = null;
        continue;
      }
      collecting.push(line);
      continue;
    }
    if (line.trim() === "```json" && pending) collecting = [];
    // A blank line between the annotation and its block is normal; anything else means the
    // annotation was not attached to an example and should not silently apply to a later one.
    else if (pending && line.trim() !== "" && !line.trim().startsWith("```")) pending = null;
  }
  return examples;
}

describe("documented protocol examples", () => {
  const examples = documentedExamples();

  it("finds the annotated examples", () => {
    expect(examples.length).toBeGreaterThan(0);
  });

  for (const example of examples) {
    it(`docs/protocol.md:${example.line} matches ${example.schema}`, () => {
      const schema = (protocol as Record<string, unknown>)[example.schema];
      expect(schema, `${example.schema} is not exported by @crossagent/protocol`).toBeDefined();
      const parsed: unknown = JSON.parse(example.json);
      expect(() => (schema as { parse: (value: unknown) => unknown }).parse(parsed)).not.toThrow();
    });
  }
});
