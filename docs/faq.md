# What Is an MCP Server? CRM Solid Social MCP Questions Answered

What is an MCP server? It is a small program that gives an AI assistant a defined set of tools it can call, over the Model Context Protocol. The CRM Solid MCP server gives your assistant tools for social DMs, scheduled posts, contacts, tasks and reporting, so you can manage every social media DM and post from your AI assistant instead of switching to a browser tab.

The answers below are grouped: understanding MCP, setup, what it can do, security and privacy, limits and costs, and where to go when something breaks.

## What is an MCP server, and how does this one work

### What is an MCP server?

A server that exposes tools, resources and prompts to an AI client over a standard protocol. Instead of every application inventing its own plugin format, an MCP client can talk to any MCP server the same way: it lists the tools, decides which one to call, sends arguments, and gets structured JSON back. MCP is an open specification with an open source SDK, and clients from several vendors implement it, which is why we shipped one server rather than one integration per assistant. The full specification is at [https://modelcontextprotocol.io](https://modelcontextprotocol.io).

### How does the CRM Solid server actually connect?

The npm package runs locally over stdio and forwards JSON-RPC to `POST https://api.crmsolid.com/mcp` with your bearer key. It is a transport, not a copy of your CRM. The platform connections (Instagram, WhatsApp and the rest) live on the CRM Solid backend, which is why no platform password or cookie ever touches your machine. The same data is available to your own code through the public REST API at `https://api.crmsolid.com/v1`, which uses PascalCase JSON instead of the camelCase the MCP tools return: see [https://crmsolid.com/public-api](https://crmsolid.com/public-api).

### Do I need to be a developer to use this?

No, but you do need to edit one JSON file and be comfortable if something needs a terminal command. There is no code to write. Most people finish setup in under ten minutes by following [./getting-started.md](./getting-started.md) and copying the config block for their client.

### Which MCP clients work with CRM Solid?

Any client that supports MCP servers over stdio. We test Claude Desktop, Claude Code and Cursor, and each has its own page: [./claude-desktop.md](./claude-desktop.md), [./claude-code.md](./claude-code.md), [./cursor.md](./cursor.md). ChatGPT and other clients are covered in [./chatgpt-and-other-clients.md](./chatgpt-and-other-clients.md), where support varies by client and by plan, so check that page before assuming a feature exists.

### Does this replace the CRM Solid panel?

No. It is a second way in, for the things an assistant is good at: triage, drafting, summarising, bulk review. The panel is still where you connect accounts, manage team members, create API keys, handle billing and see the visual pipeline. Some actions exist only in the panel by design.

## Setting up the CRM Solid MCP server

### What Node version do I need?

Node 20 or newer. The package is ESM and will fail at import time on older runtimes, usually with an error that does not mention the version. Check with `node --version` before anything else.

### Why npx instead of a global install?

`npx -y @crmsolid/mcp-server` always resolves a published version, needs no install step, and keeps nothing stale on your machine. A global install adds an upgrade you have to remember. If your machine is offline-restricted or you want reproducible startup, install it and point `command` at the binary (`crmsolid-mcp`) instead.

### How do I pin a version?

Put the version in the package specifier: `"args": ["-y", "@crmsolid/mcp-server@<version>"]`. Pinning is the right default on a shared or production machine, because it removes surprise upgrades. Released versions are listed at [https://www.npmjs.com/package/@crmsolid/mcp-server](https://www.npmjs.com/package/@crmsolid/mcp-server).

### Where do I get an API key?

At [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers). Keys look like `csk_live_...` and carry scopes, granted per key. New keys get `social:read`, `social:write`, `posts:read` and `posts:write` by default. Anything else, for example `tasks:write` or `analytics:read`, you grant deliberately.

### Can I run two CRM Solid servers side by side?

Yes, and it is a good pattern. Add two entries with different names: one read-only for research and reporting, one with writes for the work that needs them. The client shows both, and you pick which to use per conversation.

```jsonc
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server"],
      "env": { "CRMSOLID_API_KEY": "csk_live_write_key" }
    },
    "crmsolid-readonly": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server", "--read-only"],
      "env": { "CRMSOLID_API_KEY": "csk_live_read_key" }
    }
  }
}
```

### Does it work offline?

No. The local process starts fine, but every tool call goes to `api.crmsolid.com`, so with no network you get connection errors. There is no local cache and no offline queue.

## What the CRM Solid MCP server can do

### Does it work with Instagram and WhatsApp?

Yes, both, along with Facebook, X (Twitter), LinkedIn, TikTok, YouTube, Threads, Pinterest, Reddit, Bluesky and Telegram. Twelve platforms, one inbox, one set of tools. A conversation on TikTok and a conversation on Instagram come back in the same JSON shape. How many accounts you can connect is a function of your plan, not of the MCP server: if an account is missing from `crm_list_social_accounts`, or the conversation list comes back empty, connect it in the panel first.

### How many tools are there?

62 tools, 21 resources and 15 prompts. The social and posts families add 13 tools, 4 resources and 3 prompts on top of the contacts, deals, tasks, email, finance, analytics, sequences, pipelines, jobs, webhooks and agents families that were already there. Every argument is documented in [./tools-reference.md](./tools-reference.md).

### Can it post without asking me?

Not by accident. `scheduledAt` is required unless `publishNow: true` is passed, so an assistant that forgets to say when gets `scheduledAt is required unless publishNow is true` back rather than a live post. Sending a DM is the same story: `crm_send_social_message` is annotated as a write, so your client prompts before it runs and shows you the text, and a platform rejection comes back as an error instead of a silent retry. The MCP tool takes no idempotency key; code that sends with no human in the turn should use the v1 REST endpoint, which does accept one, at [https://crmsolid.com/public-api](https://crmsolid.com/public-api). Keep the draft turn and the send turn as separate messages, permanently, and drop write tools entirely with `--read-only` when you do not need them. Working patterns are in [./content-scheduling-recipes.md](./content-scheduling-recipes.md) and [./social-inbox-recipes.md](./social-inbox-recipes.md).

### Can it see my email, deals and invoices too?

Yes, if the key has those scopes and you have not narrowed the surface. `--tools social,posts` limits the exposed families to social and posts, and the filter runs locally, so a filtered tool is neither listed nor callable. Use it when you want an assistant that touches DMs and nothing else.

## Security and privacy

### Is my data used for training?

Not by CRM Solid. The npm package is a transport: it holds nothing, writes no logs of your message content, and stores no copy of your CRM. Your assistant is a separate matter: whatever your MCP client sends to its model provider is governed by that provider's policy, so if a model reads a DM in order to draft a reply, the provider's terms apply to that text. Our position is on [https://crmsolid.com/security](https://crmsolid.com/security).

### Does my Instagram password go anywhere near my laptop?

No. Platform connections are held by the CRM Solid backend and authorised in the panel. The local process only ever sees your CRM Solid bearer key and the JSON that flows through it.

### What happens if the model hallucinates a send?

It has to get past the tool schema, your client's approval prompt and the key's scopes, so the usual outcome is a rejected call rather than a message to a customer. Structural help: no tool both reads and writes, and a write returns a confirmation of what changed, never a data feed, so a model cannot obtain information by sending something. If the risk is unacceptable for a workflow, run it with `--read-only`.

### Can I use it read-only?

Yes, two ways, and you can use both. `--read-only` drops every write tool in the local proxy before the client sees the list. A key without write scopes rejects writes at the API, whatever the client decides. The flag protects against a confused client, the scope protects against a leaked config. For a locked-down setup, combine all three controls: a narrowly scoped key, `--tools` to limit the families, and `--read-only` wherever writes are not needed.

### What happens to a key when someone leaves the team?

Revoke it in the panel and it stops working immediately, everywhere it was configured. This is the argument for one key per person and per purpose rather than one shared key: revoking a shared key breaks everybody. Rotation guidance is in [./security-and-scopes.md](./security-and-scopes.md).

### Can I self-host it?

You can run the proxy yourself: it is MIT licensed and the source is at [https://github.com/CRM-Solid/crmsolid-mcp](https://github.com/CRM-Solid/crmsolid-mcp), so clone it, audit it, build it and point your client at your own build. It still calls `api.crmsolid.com`, because that is where the CRM and the platform connections live. Set `CRMSOLID_BASE_URL` only if you have been given a different endpoint to use.

## Limits and costs

### What are the rate limits?

Limits apply per key and are published on [https://crmsolid.com/public-api](https://crmsolid.com/public-api). In practice, the way to stay under them is to put a `limit` in your prompts (1 to 100, default 25) and step back through history with `beforeMessageId` instead of asking an assistant to pull an entire inbox at once. A 429 means back off and retry.

### Does the MCP server cost extra?

The package is free and MIT licensed. What it can reach depends on your CRM Solid plan and the scopes on your key, since some features are plan-gated in the product itself. Current plans are listed at [https://crmsolid.com/pricing](https://crmsolid.com/pricing). Your MCP client's own model usage is billed by whoever provides it, not by us.

### What happens when a platform revokes a connection?

Calls that touch that account start failing, usually with an authorisation error from the platform passed back through the tool call. Platforms revoke for their own reasons: an expired token, a password change, a policy action, or a permission removed by the account owner. Reconnect the account in the CRM Solid panel. Nothing on your machine needs to change, and other platforms keep working.

## When something is not working

### Why does the server not appear in my client?

Nine times out of ten the config is not valid JSON (a trailing comma, or unescaped Windows backslashes), the client was not fully restarted, or `npx` is not on the GUI application's PATH. Work through [./troubleshooting.md](./troubleshooting.md), which starts with three commands that isolate whether the fault is your key, your network or your client.

### Why is a tool missing from the list?

Almost always `--read-only` or `--tools`. Both filters run locally, so a tool removed by either is not listed and not callable, and nothing about your key or plan is involved. Check the `args` in your config before anything else.

### Why is my conversation list empty?

Usually because no social account is connected to that workspace, or the filters on the request excluded everything. Ask the assistant to call `crm_list_social_accounts` first, then retry without `status` or `platform`. A `count` of 0 with an empty `conversations` array is a real answer, not an error.

### Where do I report a bug?

At [https://github.com/CRM-Solid/crmsolid-mcp/issues](https://github.com/CRM-Solid/crmsolid-mcp/issues). Include your Node version, the package version from `npx -y @crmsolid/mcp-server --version`, your client and OS, and your config with the key redacted. The checklist at the end of [./troubleshooting.md](./troubleshooting.md) lists everything that saves a round trip.

## Where to go next

- [./getting-started.md](./getting-started.md) to install and connect
- [./social-inbox-recipes.md](./social-inbox-recipes.md) and [./content-scheduling-recipes.md](./content-scheduling-recipes.md) for working prompts
- [./tools-reference.md](./tools-reference.md) for every tool, argument and scope
- [./security-and-scopes.md](./security-and-scopes.md) for keys, scopes and rotation
- [../README.md](../README.md) and [https://docs.crmsolid.com/integrations/mcp/](https://docs.crmsolid.com/integrations/mcp/)
