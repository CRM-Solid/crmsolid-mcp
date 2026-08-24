# Cursor MCP Server Setup: Social Inbox Inside Your Editor

Configuring CRM Solid as a Cursor MCP server means the agent chat you already use for code can also read an Instagram DM, file the follow up as a task, and write a note on the contact record. Drop a JSON block into `.cursor/mcp.json` for one project or `~/.cursor/mcp.json` for every project, enable the server in Cursor settings, and the agent gains 62 tools, 21 resources and 15 prompts across 12 platforms. This page covers both config locations, enabling the server, calling tools from agent chat, the key leak that project configs invite, and one worked example.

You need Node.js 20 or newer and an API key starting with `csk_live_`. See [getting started](./getting-started.md) if you do not have one.

## Where the Cursor MCP server config lives

| Scope | Path | Applies to |
|---|---|---|
| Project | `.cursor/mcp.json` at the repo root | that project only |
| Global (macOS, Linux) | `~/.cursor/mcp.json` | every project on the machine |
| Global (Windows) | `%USERPROFILE%\.cursor\mcp.json` | every project on the machine |

Project config wins where both exist. Pick global unless you have a reason to want a different tool filter per repo.

## The JSON block

Same shape in both files:

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server", "--tools", "social,posts,contacts,tasks"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

The `--tools` list here is deliberate. `social,posts` alone gives you the inbox and the scheduler, but the worked example below writes a contact note and creates a task, and those live in the `contacts` and `tasks` families. Filtering runs in the local proxy, so a family you leave out is not listed and not callable. Drop the families you do not need, and add `--read-only` if this machine should never send anything.

Create the `.cursor` directory first if it does not exist. Cursor does not create it for you when you edit by hand.

## Enable the server in Cursor settings

1. Open Cursor Settings and find the MCP section. Depending on your version it is labelled **MCP** or **Tools and Integrations**.
2. Find `crmsolid` in the server list. A freshly added server usually needs an explicit toggle before it starts.
3. Wait for the status indicator to go green or read as ready. If it stays amber, use the refresh control on the row, which restarts the process.
4. Expand the row to see the discovered tools. That list is the proof the proxy started and authenticated.

Section names and the position of the refresh control move between Cursor releases, so if the labels here do not match your build, check Cursor's own documentation for the current layout. The JSON file itself has been stable.

## Call the tools from agent chat

Tools run in Agent mode. Inline edit (Cmd+K) and plain ask mode will not call them, which is the usual reason a correctly configured server appears to do nothing.

Open the chat panel, switch to Agent, and ask in plain language. The agent picks the tool and shows the arguments before running. Approve reads freely: `crm_list_social_conversations`, `crm_list_social_messages` and `crm_social_inbox_summary` are annotated `readOnly` and cannot change anything. Read the arguments on a write. `crm_send_social_message` sends a real DM from your brand account and is annotated non-idempotent, so approving it twice sends it twice. Every write returns a confirmation of what changed, never a data feed.

Cursor can be configured to auto-run tools without asking. If you turn that on, pair it with `--read-only` or a key scoped to `social:read` and `posts:read`, otherwise you have removed the last human check before a message goes out to a customer.

## Keep the key out of the committed project config

`.cursor/mcp.json` is an ordinary file in your repository. Commit it and everyone who clones the repo gets your key, including contractors, forks and anyone who later reads the git history. Two workable options:

1. **Keep the key out of the repo entirely.** Put the literal key in the global `~/.cursor/mcp.json`, which lives outside every project, and commit nothing.
2. **Commit the file with indirection.** Use `"CRMSOLID_API_KEY": "${CRMSOLID_API_KEY}"` and have each person export the variable in their shell profile. Environment variable expansion in Cursor's MCP config depends on the version you are running, so verify it resolves before you rely on it: if the server starts and tools appear, expansion worked, and if it fails with a missing key error, your version does not expand and you should fall back to option 1.

Either way, add `.cursor/mcp.json` to `.gitignore` if there is any chance a literal key ends up in it. If a key does get committed, revoke it at [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) instead of rewriting history. One key per machine means revoking one breaks one setup. More on this in [security and scopes](./security-and-scopes.md).

## Worked example: turn a support DM into a task and a contact note

You are mid feature and a support DM needs handling. Without leaving the editor, in Agent chat:

```text
Show me unread Instagram conversations from the last day.
```

`crm_list_social_conversations` runs with `platform: "instagram"` and `status: "active"`, and returns camelCase JSON:

```json
{
  "count": 1,
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

Then:

```text
Read conversation 4821, write a note on the contact summarising what they asked,
and create a task for me to answer it today.
```

Three calls run in sequence: `crm_list_social_messages` reads the thread, `crm_add_contact_note` writes the summary onto contact 91043, and `crm_create_task` files the follow up. Each returns a confirmation of what it changed.

When you are ready to answer, `crm_send_social_message` sends the reply and `crm_mark_social_conversation_read` clears the unread count. Approve the send yourself: the agent drafted it, but the DM goes out under your brand's handle. The send also marks an operator takeover, pausing the AI agent on that contact, and lands on the contact timeline as a message activity.

List results carry a `count` and a named array, and you bound them with `limit` (1 to 100, default 25). Message history goes further back with `beforeMessageId`, which takes the oldest id you already have. MCP tool output is camelCase; the public v1 REST API is PascalCase and is the side that pages with a cursor, so keep the two apart in anything you script.

## Next steps

- [Tools reference](./tools-reference.md): arguments and return shapes for every tool.
- [Social inbox recipes](./social-inbox-recipes.md): triage, SLA chasing, reply drafting.
- [Content scheduling recipes](./content-scheduling-recipes.md): scheduling and the `publishNow` rule.
- [Claude Desktop](./claude-desktop.md), [Claude Code](./claude-code.md), [ChatGPT and other clients](./chatgpt-and-other-clients.md).
- [Getting started](./getting-started.md), [security and scopes](./security-and-scopes.md), [troubleshooting](./troubleshooting.md), [FAQ](./faq.md), [package README](../README.md).
