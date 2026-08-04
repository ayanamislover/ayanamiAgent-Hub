# @crossagent/client

The typed client every CrossAgent Hub Adapter uses to reach a Hub: sessions and heartbeats, tasks,
messages and their delivery states, reviews, events, and the project WebSocket.

Responses are parsed with [`@crossagent/protocol`](https://www.npmjs.com/package/@crossagent/protocol)
rather than trusted, and the enrollment calls additionally check that what came back describes the
request that went out — a Hub that answers with a different session, ticket bundle or project is a
failure, not a result.

```ts
import { HubClient } from "@crossagent/client";

const hub = new HubClient({ baseUrl: "http://127.0.0.1:4387", token });
const { project } = await hub.joinProject({ cwd: process.cwd(), allowCreate: false });
const session = await hub.registerSession(project.id, {
  agentId: "local:my-agent",
  client: "fake-client",
  transport: "hook-poll",
  deliveryMode: "mailbox_only",
  host: "my-machine",
  cwd: process.cwd(),
  capabilities: ["check_inbox", "post_reply"],
});
```

Writing an Adapter, including what a third-party client can and cannot do today:
[docs/adapter-authoring.md](https://github.com/ayanamislover/ayanamiAgent-Hub/blob/main/docs/adapter-authoring.md).

Licensed AGPL-3.0-only, like the Hub it belongs to.
