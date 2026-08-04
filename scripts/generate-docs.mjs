import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import ts from "typescript";

/**
 * The WebSocket section of docs/protocol.md described a credential in the URL long after the server
 * started refusing one, and the README still advertised sixteen MCP tools after the nineteenth was
 * registered. Hand-written protocol documentation cannot keep up with the code, so the parts that
 * are enumerable are enumerated from the source instead.
 *
 * Extraction is static -- the TypeScript AST, no build and no running Hub -- so `docs:check` is
 * cheap enough to sit in the lint gate and to run on a documentation-only change, which is exactly
 * where this kind of drift lands.
 *
 *   node scripts/generate-docs.mjs           rewrite the generated reference
 *   node scripts/generate-docs.mjs --check   fail if it is out of date
 */

const repositoryRoot = resolve(import.meta.dirname, "..");
const referencePath = resolve(repositoryRoot, "docs/generated/protocol-reference.md");
const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function sourceFileOf(file) {
  return ts.createSourceFile(
    file,
    readFileSync(resolve(repositoryRoot, file), "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: repositoryRoot,
    encoding: "buffer",
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((file) => file.replaceAll("\\", "/"));
}

/** The text of a literal argument, or null for anything computed. */
function literalText(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/** The leftmost identifier of `a.b.c(...)`, which is the receiver a chained call started from. */
function receiverRoot(expression) {
  let current = expression;
  for (;;) {
    if (ts.isIdentifier(current)) return current.text;
    if (ts.isPropertyAccessExpression(current)) current = current.expression;
    else if (ts.isCallExpression(current)) current = current.expression;
    else return null;
  }
}

function calls(node, methodName, visit) {
  const walk = (current) => {
    if (
      ts.isCallExpression(current) &&
      ts.isPropertyAccessExpression(current.expression) &&
      current.expression.name.text === methodName
    ) {
      visit(current);
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
}

function mcpTools() {
  const file = "apps/hub/src/mcp/server.ts";
  const tools = [];
  calls(sourceFileOf(file), "registerTool", (call) => {
    const name = literalText(call.arguments[0]);
    const options = call.arguments[1];
    if (!name || !options || !ts.isObjectLiteralExpression(options)) return;
    const description = options.properties.find(
      (property) =>
        ts.isPropertyAssignment(property) &&
        ts.isIdentifier(property.name) &&
        property.name.text === "description",
    );
    tools.push({
      name,
      description: description ? (literalText(description.initializer) ?? "") : "",
    });
  });
  return tools.sort((left, right) => (left.name < right.name ? -1 : 1));
}

function httpRoutes() {
  const routes = [];
  for (const file of trackedFiles().filter(
    (name) => name.startsWith("apps/hub/src/") && name.endsWith(".ts"),
  )) {
    const source = sourceFileOf(file);
    const walk = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        httpMethods.has(node.expression.name.text)
      ) {
        const path = literalText(node.arguments[0]);
        // A path argument is the only thing that separates a route registration from
        // `map.get(key)`, so anything that is not a literal route is not one.
        if (path?.startsWith("/")) {
          routes.push({ method: node.expression.name.text.toUpperCase(), path, file });
        }
      }
      ts.forEachChild(node, walk);
    };
    walk(source);
  }
  return routes.sort((left, right) =>
    left.path === right.path
      ? left.method < right.method
        ? -1
        : 1
      : left.path < right.path
        ? -1
        : 1,
  );
}

function cliCommands() {
  const file = "packages/cli/src/bin.ts";
  const source = sourceFileOf(file);
  // `const project = program.command("project")` names a group whose children are registered on
  // the variable, so the variable has to be resolved to a prefix before the children make sense.
  const prefixByVariable = new Map([["program", ""]]);
  const declarations = [];
  const walkDeclarations = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isPropertyAccessExpression(node.initializer.expression) &&
      node.initializer.expression.name.text === "command"
    ) {
      const name = literalText(node.initializer.arguments[0]);
      const parent = receiverRoot(node.initializer.expression.expression);
      if (name && parent) declarations.push({ variable: node.name.text, parent, name });
    }
    ts.forEachChild(node, walkDeclarations);
  };
  walkDeclarations(source);
  // Declarations can name a parent declared later in the file, so resolve until nothing moves.
  for (let pass = 0; pass < declarations.length + 1; pass += 1) {
    for (const declaration of declarations) {
      const prefix = prefixByVariable.get(declaration.parent);
      if (prefix === undefined || prefixByVariable.has(declaration.variable)) continue;
      prefixByVariable.set(
        declaration.variable,
        prefix ? `${prefix} ${declaration.name}` : declaration.name,
      );
    }
  }

  const statementOf = (node) => {
    let current = node;
    while (current.parent && !ts.isSourceFile(current.parent)) current = current.parent;
    return current;
  };
  const commands = [];
  calls(source, "command", (call) => {
    const name = literalText(call.arguments[0]);
    const parent = receiverRoot(call.expression.expression);
    if (!name || parent === null) return;
    const prefix = prefixByVariable.get(parent);
    if (prefix === undefined) return;
    const full = prefix ? `${prefix} ${name}` : name;
    // A group's declaration and its own registration are the same call; keep it once.
    if (commands.some((command) => command.name === full)) return;
    // Everything chained onto this command lives in the same top-level statement, and each
    // statement registers exactly one command.
    const statement = statementOf(call);
    const parts = [];
    calls(statement, "argument", (argument) => {
      const signature = literalText(argument.arguments[0]);
      if (signature) parts.push(signature);
    });
    let description = "";
    calls(statement, "description", (described) => {
      description = literalText(described.arguments[0]) ?? description;
    });
    commands.push({ name: full, arguments: parts, description });
  });
  return commands.sort((left, right) => (left.name < right.name ? -1 : 1));
}

function render({ tools, routes, commands }) {
  const escape = (value) => value.replaceAll("|", "\\|");
  const lines = [
    "# Generated protocol reference",
    "",
    "<!-- Generated by scripts/generate-docs.mjs. Do not edit; run `pnpm docs:generate`. -->",
    "",
    "Everything here is read out of the source, so it cannot drift from what the code registers.",
    "The prose that explains *why* each of these exists lives in [the protocol](../protocol.md) and",
    "[the architecture](../architecture.md); this file only says what is there.",
    "",
    `## MCP tools (${tools.length})`,
    "",
    "Registered in `apps/hub/src/mcp/server.ts` and reachable over the Streamable HTTP MCP endpoint",
    "with an ACTIVE `MODEL_MCP` session ticket.",
    "",
    "| Tool | What it does |",
    "| --- | --- |",
    ...tools.map((tool) => `| \`${tool.name}\` | ${escape(tool.description)} |`),
    "",
    `## HTTP routes (${routes.length})`,
    "",
    "Every route the Hub registers, with the module that registers it. Authentication and scope are",
    "per-route and are described in [the protocol](../protocol.md).",
    "",
    "| Method | Path | Registered in |",
    "| --- | --- | --- |",
    ...routes.map(
      (route) => `| ${route.method} | \`${route.path}\` | \`${relative(".", route.file)}\` |`,
    ),
    "",
    `## Command line (${commands.length})`,
    "",
    "The `crossagent` command tree as Commander registers it in `packages/cli/src/bin.ts`.",
    "",
    // The column appears by itself once any command carries a description, and an empty cell reads
    // as the same "nothing here" the Arguments column already uses rather than as a broken row.
    ...(commands.some((command) => command.description)
      ? [
          "| Command | Arguments | What it does |",
          "| --- | --- | --- |",
          ...commands.map(
            (command) =>
              `| \`crossagent ${command.name}\` | ${command.arguments.map((part) => `\`${escape(part)}\``).join(" ") || "—"} | ${escape(command.description) || "—"} |`,
          ),
        ]
      : [
          "| Command | Arguments |",
          "| --- | --- |",
          ...commands.map(
            (command) =>
              `| \`crossagent ${command.name}\` | ${command.arguments.map((part) => `\`${escape(part)}\``).join(" ") || "—"} |`,
          ),
        ]),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

/** Counts written into prose go stale silently; the generated file is the only source for them. */
function countProblems(tools) {
  const problems = [];
  // The count is written several ways -- "19 MCP tools", "19 Streamable HTTP MCP tools", the same
  // two in Chinese -- so the qualifier between the number and the noun is allowed to be anything
  // short rather than enumerated.
  const patterns = [
    { pattern: /(\d+)(?:\s+[A-Za-z]+){0,3}\s+MCP tools/gu, label: "MCP tools" },
    { pattern: /(\d+)\s*个[^\n]{0,24}?MCP\s*工具/gu, label: "MCP 工具" },
  ];
  for (const file of trackedFiles().filter((name) => name.endsWith(".md"))) {
    if (file === relative(repositoryRoot, referencePath).replaceAll("\\", "/")) continue;
    const text = readFileSync(resolve(repositoryRoot, file), "utf8");
    for (const { pattern, label } of patterns) {
      for (const match of text.matchAll(pattern)) {
        if (Number(match[1]) !== tools.length) {
          problems.push(`${file} says ${match[1]} ${label}; the code registers ${tools.length}`);
        }
      }
    }
  }
  return problems;
}

/**
 * Every JSON example in the protocol document has to say which schema it is an example of, so that
 * one can be validated against the other. `unvalidated:` is allowed and has to give a reason --
 * the point is that an unchecked example is visible rather than merely absent.
 */
function exampleProblems() {
  const file = "docs/protocol.md";
  const text = readFileSync(resolve(repositoryRoot, file), "utf8");
  const lines = text.split(/\r?\n/);
  const problems = [];
  for (const [index, line] of lines.entries()) {
    if (line.trim() !== "```json") continue;
    const annotation = lines
      .slice(Math.max(0, index - 3), index)
      .find((candidate) => /^<!--\s*(?:schema|unvalidated):/u.test(candidate.trim()));
    if (!annotation) {
      problems.push(
        `${file}:${index + 1} has a JSON example with no <!-- schema: Name --> or <!-- unvalidated: reason --> above it`,
      );
    }
  }
  return problems;
}

const reference = render({ tools: mcpTools(), routes: httpRoutes(), commands: cliCommands() });
const problems = [...countProblems(mcpTools()), ...exampleProblems()];

if (process.argv.includes("--check")) {
  let committed = null;
  try {
    committed = readFileSync(referencePath, "utf8");
  } catch {
    problems.push("docs/generated/protocol-reference.md is missing; run `pnpm docs:generate`");
  }
  if (committed !== null && committed !== reference) {
    problems.push(
      "docs/generated/protocol-reference.md is out of date; run `pnpm docs:generate` and commit it",
    );
  }
  if (problems.length > 0) {
    console.error("Documentation check failed:");
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
  } else {
    console.log("Documentation check passed: generated reference matches the source.");
  }
} else {
  mkdirSync(resolve(repositoryRoot, "docs/generated"), { recursive: true });
  writeFileSync(referencePath, reference, "utf8");
  console.log(`Wrote ${relative(repositoryRoot, referencePath)}`);
  for (const problem of problems) console.warn(`- ${problem}`);
}
