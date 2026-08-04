/* global process */
import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  process.stdout.write(
    `${JSON.stringify({
      id: message.id,
      error: { code: -32002, message: "fixture rejected initialization" },
    })}\n`,
  );
});
