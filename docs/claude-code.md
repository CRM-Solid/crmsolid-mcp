# Claude Code MCP Server: Manage Social DMs From the Terminal

Adding CRM Solid as a Claude Code MCP server is one command, and after it you can triage an Instagram inbox, draft a launch post from your own `CHANGELOG.md`, and queue it for tomorrow morning without leaving the terminal. The server publishes 62 tools, 21 resources and 15 prompts across 12 platforms: Instagram, Facebook, X (Twitter), LinkedIn, TikTok, YouTube, Threads, Pinterest, Reddit, Bluesky, Telegram and WhatsApp. This page covers `claude mcp add`, the project scoped `.mcp.json` you can commit, per project `--tools` narrowing, checking the connection with `/mcp`, and a release day routine end to end.

You need Node.js 20 or newer and an API key starting with `csk_live_`. Create one in [getting started](./getting-started.md) if you have not.

## Add the Claude Code MCP server in one command

Keep the key in your shell environment, then reference it:

```bash
export CRMSOLID_API_KEY="csk_live_..."
claude mcp add crmsolid --env CRMSOLID_API_KEY="$CRMSOLID_API_KEY" -- npx -y @crmsolid/mcp-server
```

Everything after `--` is the command Claude Code will spawn. The `--env` flag passes the key into that process without writing it into a config file you might later share.

Claude Code stores servers at three scopes: local (this project, only you), project (this project, shared through a committed file), and user (every project on this machine). A key you use everywhere belongs at user scope. Scope flag spelling has changed between releases, so confirm with `claude mcp add --help` on your version rather than copying a flag from an old blog post.

## Commit a project scoped .mcp.json without leaking the key

A `.mcp.json` at the repo root gives everyone who clones the repo the same server, with the same tool filter, automatically. Claude Code prompts each user before it trusts a project scoped server the first time.

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server", "--tools", "social,posts"],
      "env": { "CRMSOLID_API_KEY": "${CRMSOLID_API_KEY}" }
    }
  }
}
```

The `${CRMSOLID_API_KEY}` indirection is the whole point. **Never put a literal `csk_live_` value in a committed file.** Each person exports their own key in their shell profile, and the file itself carries no secret. If the variable is unset the server fails to start with a missing key error, which is exactly the failure you want: loud, local, and harmless.

Two habits that go with this:

- Document the required variable in your repo README next to the build instructions, so a new joiner knows what to export.
- If a key does reach a commit, rotate it at [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) rather than rewriting history and hoping. Revoking is instant, and one key per machine means revoking one breaks one setup.

## Narrow the tool surface per project

A support repo does not need finance tools. A marketing repo does not need deals. Filter per project and the agent has less to get wrong:

| Repo type | Args |
|---|---|
| Support | `["-y", "@crmsolid/mcp-server", "--tools", "social,contacts,tasks"]` |
| Marketing | `["-y", "@crmsolid/mcp-server", "--tools", "social,posts"]` |
| Shared or CI machine | `["-y", "@crmsolid/mcp-server", "--tools", "social,posts", "--read-only"]` |

`--tools` and `--read-only` run inside the local proxy, so a filtered tool is not listed and not callable. `--read-only` drops every write tool before Claude Code ever sees the list.

Be deliberate about this in Claude Code specifically. It is a terminal client, so CRM Solid tools sit in the same approval loop as file edits, `git` and arbitrary shell commands. An agent already permitted to run commands in your repo is one confused step away from also sending a DM from your brand account. On any machine that is shared, on any long autonomous run, and on CI, `--read-only` is the right default, and a second API key holding only `social:read` and `posts:read` is better still. Local flags protect against a confused assistant, key scopes protect against a copied config. See [security and scopes](./security-and-scopes.md).

## Check it loaded with /mcp

Inside a session, run:

```text
/mcp
```

You get the server, its status and its counts:

```text
crmsolid   connected   tools: 62   resources: 21   prompts: 15
```

That is the unfiltered surface. With `--tools social,posts` in the args the count drops to those two families, and `--read-only` drops it again by removing every write tool. A lower number here is the filter working, not a broken install. From outside a session:

```bash
claude mcp list
```

If `crmsolid` is missing entirely, you added it at a different scope than the directory you are sitting in. If it is present but failed, run the proxy by hand to see the real error:

```bash
npx -y @crmsolid/mcp-server --version
```

That prints a version and exits. A failure there is Node or network, not Claude Code. Everything else is in [troubleshooting](./troubleshooting.md).

## Worked example: a release day routine

The point of having CRM Solid next to your file tools is that the source of truth for a launch post is already in the repo.

Ask for it in one message:

```text
Read CHANGELOG.md, take the top entry, and draft a launch post for LinkedIn and X.
Under 60 words, no hashtags, plain language. Schedule it for 26 August 09:00
Europe/Istanbul. Do not publish it now.
```

What runs, in order:

1. Claude Code reads `CHANGELOG.md` with its own file tools. No CRM Solid tool involved.
2. `crm_list_social_accounts` resolves which LinkedIn and X accounts you have, and returns their ids.
3. `crm_schedule_social_post` is called with `content`, `platforms`, `accountIds` and `scheduledAt`. You approve it after reading the arguments, and `scheduledAt` is the one to read hardest. Either carry the offset (`2026-08-26T09:00:00+03:00`, or the same instant written `2026-08-26T06:00:00Z`), or pass a bare wall clock with `timeZone` set (`2026-08-26T09:00:00` plus `Europe/Istanbul`) and let the server convert it. A bare wall clock with no `timeZone` beside it is taken as UTC, which is how a nine in the morning post goes out at noon.

The confirmation comes back in camelCase:

```json
{
  "count": 2,
  "postIds": [993, 994],
  "platforms": ["linkedin", "x"],
  "scheduledAt": "2026-08-26T06:00:00Z",
  "status": "pending",
  "skipped": null,
  "message": "Scheduled on 2 account(s) for 2026-08-26 06:00 UTC."
}
```

Two ids come back because one post row is created per target account, up to 20 per call, and each account's daily post limit is checked before anything is written. Ids are integers, and the confirmation echoes the instant in UTC, so 09:00 Istanbul reads back as `06:00:00Z`. If it reads back as `09:00:00Z`, the offset was left off and the post is three hours late.

The scheduling rule is worth stating plainly, because it is the safety story. `scheduledAt` is required unless `publishNow: true` is passed, so a call that names no time comes back with `scheduledAt is required unless publishNow is true` and nothing is created. An agent that misreads a date gets a rejection, never an accidental broadcast to your audience right now.

Then the follow ups, all in the same session:

- `Show me post 993` calls `crm_get_social_post`.
- `Change the second line, keep the schedule` calls `crm_update_social_post`, which is annotated idempotent.
- `Pull it, the release slipped` calls `crm_cancel_social_post`.

MCP tool output is camelCase throughout. The public v1 REST API is PascalCase. If you script against both, keep them apart. Only the REST side pages with a cursor: the MCP list tools take `limit` (1 to 100, default 25) and return a named array plus a `count`.

## Next steps

- [Tools reference](./tools-reference.md): every argument and return shape.
- [Content scheduling recipes](./content-scheduling-recipes.md): weekly plans, reschedules, cancellations.
- [Social inbox recipes](./social-inbox-recipes.md): triage loops that keep a human approving sends.
- [Claude Desktop](./claude-desktop.md) for the GUI client, [Cursor](./cursor.md) for the editor.
- [ChatGPT and other clients](./chatgpt-and-other-clients.md) for remote transport.
- [Security and scopes](./security-and-scopes.md), [troubleshooting](./troubleshooting.md), [FAQ](./faq.md), [package README](../README.md).
