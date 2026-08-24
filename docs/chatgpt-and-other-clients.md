# ChatGPT MCP Server and Other Clients: Connecting CRM Solid Everywhere

Connecting a ChatGPT MCP server to CRM Solid works differently from connecting a desktop client, and the difference is transport. The npm package `@crmsolid/mcp-server` speaks stdio: a client on your machine spawns it as a child process and talks over stdin and stdout. ChatGPT runs in a browser and cannot spawn anything on your laptop, so it needs a URL instead. For that, point it at the hosted JSON-RPC endpoint `https://api.crmsolid.com/mcp` with an `Authorization: Bearer csk_live_...` header. Both routes reach the same server, the same 62 tools, 21 resources and 15 prompts, and the same 12 platforms. This page covers the split, ChatGPT developer mode, a raw `curl` check that proves your key works with no client at all, a generic stdio block, and a table for Windsurf, Zed, Continue, Cline, VS Code agent mode and LibreChat.

## Two transports, one server

| | Local stdio | Hosted URL |
|---|---|---|
| What you configure | `npx -y @crmsolid/mcp-server` | `https://api.crmsolid.com/mcp` |
| Auth | `CRMSOLID_API_KEY` in the process env | `Authorization: Bearer csk_live_...` header |
| Who uses it | Claude Desktop, Claude Code, Cursor, Windsurf, Zed, Continue, Cline, VS Code | ChatGPT connectors, hosted agent platforms, anything without a local process |
| `--tools` and `--read-only` | available | not available, those flags live in the local proxy |

The stdio package is a thin proxy over the hosted endpoint. It forwards `tools/list`, `tools/call`, `resources/*` and `prompts/*` as JSON-RPC to that same URL and applies your local filters on the way through. Nothing is exclusive to one transport except those local filters.

That exception matters. On a remote client you cannot pass `--read-only`, so the only way to bound what a connector can do is the key itself. Issue a separate key with only `social:read` and `posts:read` for any remote connection you would not hand write access to. Scope enforcement is server side and applies to both transports. Details in [security and scopes](./security-and-scopes.md).

## Connect a ChatGPT MCP server through developer mode

ChatGPT reaches MCP servers through custom connectors, which are exposed under developer mode in settings. The rough shape is: open settings, find Connectors, enable developer mode, add a connector, and give it the server URL plus the authentication header.

Enter `https://api.crmsolid.com/mcp` as the server URL and supply your key as a bearer token in the `Authorization` header. After the connector saves, ChatGPT fetches the tool list, and that list is your confirmation the key and scopes are right.

Two honest caveats. Custom connector availability depends on your ChatGPT plan and on OpenAI's rollout, so the option may not be present in your account. And what a connector is permitted to call varies by ChatGPT surface: some modes expose a narrow subset of a server's tools rather than everything it publishes. Check OpenAI's own connector documentation for the current state before assuming a tool you can see in `curl` will be callable in chat. If the connector UI shows a tool list, trust that list over anything written here.

## Prove the key works with curl before you touch a client

Run this first when a client will not connect. It removes the client from the equation entirely.

```bash
curl -sS https://api.crmsolid.com/mcp \
  -H "Authorization: Bearer csk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

A working key returns the tool list, truncated here:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "tools": [
      { "name": "crm_list_social_accounts", "description": "List connected social accounts" },
      { "name": "crm_list_social_conversations", "description": "List social DM conversations" },
      { "name": "crm_social_inbox_summary", "description": "Counts of active and unread conversations" }
    ]
  }
}
```

How to read the outcome:

- HTTP 401: the key is wrong, revoked, or truncated on paste. Reissue at [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers).
- A tool list that is missing the social tools: the key lacks `social:read` or `posts:read`. Fix the scopes, not the client.
- A full list: your key and the endpoint are fine, and any remaining problem is client side. Go to [troubleshooting](./troubleshooting.md).

Call a tool the same way:

```bash
curl -sS https://api.crmsolid.com/mcp \
  -H "Authorization: Bearer csk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"crm_social_inbox_summary","arguments":{}}}'
```

The payload comes back in camelCase:

```json
{
  "accounts": 4,
  "conversations": 132,
  "activeConversations": 34,
  "archivedConversations": 98,
  "unreadConversations": 11,
  "unreadMessages": 19,
  "lastMessageAt": "2026-08-24T08:41:12Z",
  "platforms": [
    { "platform": "instagram", "conversations": 71, "unreadConversations": 7, "unreadMessages": 12 },
    { "platform": "linkedin", "conversations": 38, "unreadConversations": 3, "unreadMessages": 5 }
  ],
  "awaitingReply": [
    { "conversationId": 4821, "platform": "instagram", "participantName": "Dilara K.", "contactId": 91043, "unreadCount": 2, "lastMessageAt": "2026-08-24T08:41:12Z" }
  ]
}
```

MCP output is camelCase and ids are integers. The public v1 REST API at `https://api.crmsolid.com/v1` is PascalCase and pages with a cursor, while the MCP list tools take `limit` and return a `count`. Do not mix the two in one script.

## A generic stdio block for local clients

Most desktop and editor clients take this block, or something one rename away from it:

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server", "--tools", "social,posts"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

Three renames cover almost every variation. Some clients use `servers` rather than `mcpServers`. Some require an explicit `"type": "stdio"` next to `command`. Zed uses its own `context_servers` key. The `command`, `args` and `env` triple is the part that stays constant, so when a client's docs show a different wrapper, keep the inside and change the outside.

## Client table: config file, transport, notes

| Client | Config location | Transport | Notes |
|---|---|---|---|
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json`, `%APPDATA%\Claude\claude_desktop_config.json` | stdio | Full walkthrough in [claude-desktop.md](./claude-desktop.md) |
| Claude Code | `claude mcp add`, or `.mcp.json` at the repo root | stdio | Full walkthrough in [claude-code.md](./claude-code.md) |
| Cursor | `.cursor/mcp.json`, `~/.cursor/mcp.json` | stdio | Full walkthrough in [cursor.md](./cursor.md). Tools run in Agent mode only |
| ChatGPT | Connectors UI, no local file | hosted URL | Developer mode, plan and rollout dependent |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` | stdio, remote support varies by build | Same `mcpServers` shape |
| Zed | `settings.json`, under `context_servers` | stdio | Different wrapper key, same command and args |
| Continue | `~/.continue/config.yaml`, older builds use `config.json` | stdio | The MCP block moved between the two formats, check your version |
| Cline | VS Code extension settings, `cline_mcp_settings.json` | stdio, remote in recent builds | Has an MCP servers panel that edits the file for you |
| VS Code agent mode | `.vscode/mcp.json` for a workspace, user `mcp.json` for global | stdio and remote | Uses `servers`, and supports an `inputs` block so the key is prompted for rather than stored in the file |
| LibreChat | `librechat.yaml`, `mcpServers` section | stdio and remote | Server side config, so the key lives on the host, not on user machines |

Treat that table as a starting point, not a contract. Config paths, key names and transport support change with client releases, and a table like this ages faster than the software it describes. Check the client's own documentation for the current state before you file a bug against the package. If the client shows a discovered tool list after you save the config, it is connected, whatever the docs said.

## Picking a transport

- The client runs on your machine and can spawn a process: use stdio. You get `--tools` and `--read-only`.
- The client runs in a browser or on someone else's servers: use the hosted URL, and bound it with key scopes instead of flags.
- You are testing, scripting or debugging: use `curl` against the hosted endpoint. No client, no config file, no ambiguity about which layer is broken.
- You are giving access to someone outside the team: issue a read-only key, whatever the transport.

## Next steps

- [Getting started](./getting-started.md): key creation, scopes, first connection.
- [Tools reference](./tools-reference.md): every tool, argument and return shape.
- [Security and scopes](./security-and-scopes.md): what each scope grants and how writes are bounded.
- [Social inbox recipes](./social-inbox-recipes.md) and [content scheduling recipes](./content-scheduling-recipes.md).
- [Troubleshooting](./troubleshooting.md), [FAQ](./faq.md), [package README](../README.md).
- [MCP specification](https://modelcontextprotocol.io) for the protocol itself.
