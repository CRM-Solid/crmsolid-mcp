# MCP CRM Integration: Connect CRM Solid to Any AI Assistant

This MCP CRM integration puts your social inbox and your CRM records inside the assistant you already use. Install one npm package, paste a nine line JSON block into your client, and Claude Desktop, Claude Code, Cursor or any other Model Context Protocol client can read an Instagram DM, draft the reply, schedule a LinkedIn post for Tuesday morning, and log all of it against a contact. The server publishes 62 tools, 21 resources and 15 prompts against your CRM Solid workspace, covering 12 platforms: Instagram, Facebook, X (Twitter), LinkedIn, TikTok, YouTube, Threads, Pinterest, Reddit, Bluesky, Telegram and WhatsApp. Budget five minutes: one API key, one config file, one restart.

## How the MCP CRM integration fits together

There are four hops. Your client launches the stdio proxy with `npx -y @crmsolid/mcp-server`. The proxy speaks MCP over stdin and stdout and forwards every `tools/list`, `tools/call`, `resources/*` and `prompts/*` call as JSON-RPC to `POST https://api.crmsolid.com/mcp`, with your bearer key in the `Authorization` header. The CRM Solid backend holds your platform connections and does the actual work: pulling the Instagram thread, sending the WhatsApp reply, queueing the LinkedIn post. Results come back down the same path.

```text
AI client
  -> stdio proxy: npx -y @crmsolid/mcp-server
  -> POST https://api.crmsolid.com/mcp   (Authorization: Bearer csk_live_...)
  -> your connected platform accounts
```

Two consequences matter on day one. No platform password, session cookie or OAuth token ever touches the machine running the proxy: those connections live server side, and the local process only ever holds your CRM Solid key. And the proxy is where local filtering happens, so `--tools` and `--read-only` are applied before the client sees a tool list. A filtered tool is not listed and not callable, whatever the assistant decides it wants.

## What you need before you install

| Requirement | How to check |
|---|---|
| Node.js 20 or newer | `node --version`. The package is ESM and declares `"node": ">=20"`. |
| A CRM Solid account | Sign in at `https://app.crmsolid.com`. Plan availability is on the [pricing page](https://crmsolid.com/pricing). |
| At least one connected social account | Connect Instagram, WhatsApp, LinkedIn or any of the other 9 platforms in the app first. |
| An MCP capable client | Claude Desktop, Claude Code, Cursor, VS Code agent mode, Windsurf, Zed and others. |

Connect at least one social account before you start. With zero connected accounts the server still loads and every tool still appears, but `crm_list_social_accounts` returns `count: 0` and an empty `accounts` array, and the whole setup looks broken when it is only empty.

## Create an API key and choose scopes

1. Open [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers).
2. Create a key and name it after the machine and client that will hold it, for example `laptop-claude-desktop`. One key per client, so you can revoke one without breaking the rest.
3. Pick scopes. The four social scopes are enabled by default on a new key.
4. Copy the key. It starts with `csk_live_` and is shown once.
5. Store it in the client config or a shell environment variable. Never in a file you commit.

| Scope | What it allows | Default on a new key |
|---|---|---|
| `social:read` | Read social DM accounts, conversations and messages | Yes |
| `social:write` | Send social DMs, mark conversations read | Yes |
| `posts:read` | Read scheduled and published posts plus stats | Yes |
| `posts:write` | Create, update and cancel social posts | Yes |

Older tool families use the same `family:action` shape: `contacts:read`, `contacts:write`, `deals:read`, `deals:write`, `tasks:read`, `tasks:write`, `email:read`, `email:write`, `finance:read`, `analytics:read` and more. The full list, plus what each one unlocks, is in [security and scopes](./security-and-scopes.md).

Scope enforcement is server side. A key holding only `social:read` and `posts:read` cannot send a DM or create a post, no matter what the assistant asks for. The `--read-only` flag is a second, local layer on top of that.

## Add the server to your client

Every client that spawns a local process takes the same block. Paste it into the client's MCP config file and replace the key.

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

If the file already has an `mcpServers` object, add `crmsolid` as a sibling key rather than replacing what is there. File locations and per client quirks are covered in [Claude Desktop](./claude-desktop.md), [Claude Code](./claude-code.md), [Cursor](./cursor.md), and [ChatGPT and other clients](./chatgpt-and-other-clients.md).

## Verify the connection

Run three checks, in this order, so a failure tells you which hop broke.

**1. Can Node run the package at all?**

```bash
npx -y @crmsolid/mcp-server --version
```

That prints a version and exits. If it hangs or errors, the problem is Node or the network, not your key and not your client.

**2. Does the client see the tools?**

Open the client's MCP panel. A healthy server reports as connected with a tool count:

```text
crmsolid: connected
tools: 62   resources: 21   prompts: 15

crm_list_social_accounts            social:read    readOnly
crm_list_social_conversations       social:read    readOnly
crm_get_social_conversation         social:read    readOnly
crm_list_social_messages            social:read    readOnly
crm_send_social_message             social:write   openWorld, non-idempotent
crm_mark_social_conversation_read   social:write   idempotent
crm_social_inbox_summary            social:read    readOnly
crm_list_social_posts               posts:read     readOnly
crm_get_social_post                 posts:read     readOnly
crm_schedule_social_post            posts:write    openWorld
crm_update_social_post              posts:write    idempotent
crm_cancel_social_post              posts:write    idempotent
crm_social_post_stats               posts:read     readOnly
```

A count below 62 has three usual causes: you passed `--tools`, `--read-only` is on and every write tool was dropped, or the key is missing scopes. All three are covered in [troubleshooting](./troubleshooting.md).

**3. The three line smoke test.**

1. Open a new chat.
2. Type: `List my connected social accounts.`
3. Approve the `crm_list_social_accounts` call.

You should get one row per connected account. Follow it with `Show me my unread Instagram conversations` and you get a result in this shape:

```json
{
  "count": 2,
  "conversations": [
    {
      "id": 4821,
      "platform": "instagram",
      "participantName": "Dilara K.",
      "participantUsername": "dilarak",
      "contactId": 91043,
      "unreadCount": 2,
      "status": "active",
      "lastMessageAt": "2026-08-24T08:41:12Z",
      "lastMessageOutgoing": false,
      "lastMessagePreview": "is the 12 month plan still available?"
    }
  ]
}
```

MCP tool output is camelCase. The public v1 REST API at `https://api.crmsolid.com/v1` is PascalCase. Pick one per script and do not mix them. Ids are integers on both. MCP list tools take `limit` (1 to 100, default 25) and return a named array plus a `count`, and message history pages backwards with `beforeMessageId`. Cursor pagination (`after`, `nextCursor`, `hasMore`) belongs to the v1 REST API, not to these tools.

## Narrow the surface with --tools and --read-only

The full server is a lot of tools for one job. Two flags cut it down, and both run in the local proxy.

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server", "--tools", "social,posts", "--read-only"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

| Env | Flag | Default |
|---|---|---|
| `CRMSOLID_API_KEY` | `--api-key` | required |
| `CRMSOLID_BASE_URL` | `--base-url` | `https://api.crmsolid.com` |
| `CRMSOLID_TOOLS` | `--tools` | all families |
| `CRMSOLID_READ_ONLY` | `--read-only` | off |
| (none) | `--version`, `--help` | (none) |

`--tools` takes a comma separated family list: `social`, `posts`, `contacts`, `deals`, `tasks`, `email`, `finance` and the rest. `--read-only` drops every write tool before the client sees the list, so `crm_send_social_message` and `crm_schedule_social_post` are not refused at call time, they are absent. Three profiles cover most setups:

| Profile | Args | Use it for |
|---|---|---|
| Full | none | your own machine, your own key |
| Social only | `--tools social,posts` | a marketing or support workflow with less to get wrong |
| Read-only review | `--tools social,posts --read-only` | shared laptops, demos, contractors |

Every tool carries MCP annotations and no tool both reads and writes. A write returns a confirmation of what changed, never a data feed. Scheduling has one more guard worth memorising: `scheduledAt` is required unless `publishNow: true` is passed, so a call that names no time is rejected with `scheduledAt is required unless publishNow is true`. An assistant that forgets to say when gets an error, never a surprise publish.

## Where to go next

- [Claude Desktop setup](./claude-desktop.md): config file paths, prompts, resources, and the failure modes specific to a GUI app.
- [Claude Code setup](./claude-code.md): `claude mcp add`, project scoped `.mcp.json`, and a release day routine.
- [Cursor setup](./cursor.md): `.cursor/mcp.json` and turning a support DM into a task without leaving the editor.
- [ChatGPT and other clients](./chatgpt-and-other-clients.md): the hosted URL, a raw `curl` check, Windsurf, Zed, Continue, Cline, VS Code and LibreChat.
- [Tools reference](./tools-reference.md): every tool, argument and return shape.
- [Security and scopes](./security-and-scopes.md): what each scope grants, key rotation, and how writes are bounded.
- [Social inbox recipes](./social-inbox-recipes.md): triage, SLA chasing, and reply drafting that a human still approves.
- [Content scheduling recipes](./content-scheduling-recipes.md): weekly plans, time zones, and cancelling a queued post.
- [Troubleshooting](./troubleshooting.md) and the [FAQ](./faq.md) when something does not connect.
- [Package README](../README.md) for install, flags and release notes.
