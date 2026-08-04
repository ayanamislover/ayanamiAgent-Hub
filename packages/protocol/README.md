# @crossagent/protocol

The contract every CrossAgent Hub Adapter is validated against: Zod schemas, the domain types they
infer, and the constants the Hub enforces — delivery modes, task transitions, message priorities,
session ticket purposes.

It is the same module the Hub itself parses requests with, so a payload this package accepts is a
payload the Hub accepts. Nothing here talks to a network; for that, see
[`@crossagent/client`](https://www.npmjs.com/package/@crossagent/client).

```ts
import { RegisterSessionInputSchema, DELIVERY_MODES } from "@crossagent/protocol";

const registration = RegisterSessionInputSchema.parse({
  projectId,
  agentId: "local:my-agent",
  client: "fake-client",
  transport: "hook-poll",
  deliveryMode: "mailbox_only",
  host: "my-machine",
  cwd: process.cwd(),
  capabilities: ["check_inbox", "post_reply"],
});
```

Writing an Adapter: [docs/adapter-authoring.md](https://github.com/ayanamislover/ayanamiAgent-Hub/blob/main/docs/adapter-authoring.md).

Licensed AGPL-3.0-only, like the Hub it belongs to.
