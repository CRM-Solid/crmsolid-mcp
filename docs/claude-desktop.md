# Claude Desktop MCP Server Setup for Social Media DMs and Posts

Running CRM Solid as a Claude Desktop MCP server takes one JSON file and one restart. Add the block below to `claude_desktop_config.json`, quit Claude Desktop completely, reopen it, and the app gains 62 tools, 21 resources and 15 prompts against your workspace: Instagram and WhatsApp DMs, LinkedIn and X posts, contacts, tasks and deals. This page covers the exact file paths on macOS and Windows, how to confirm the server loaded, the three prompts and four resources you get for social work, a read-only profile for a shared laptop, and the three failure modes that account for most broken setups.

If you have not created an API key yet, do that first in [getting started](./getting-started.md). You need a key that starts with `csk_live_` and Node.js 20 or newer.

## Where the Claude Desktop MCP server config file lives

| OS | Path |
|---|---|
| macOS | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Windows | `%APPDATA%\Claude\claude_desktop_config.json` |

The reliable way to open it is from inside the app: **Settings**, then **Developer**, then **Edit Config**. That opens the file in your editor and creates it if it does not exist yet. Creating it by hand works too, as long as the parent directory already exists.

## Paste the config and restart

Put this in the file. If `mcpServers` already exists, add `crmsolid` as a sibling key instead of replacing the object.

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

Then quit the app completely and start it again. Claude Desktop reads this file only at launch.

Quitting completely means Cmd+Q on macOS, not the red close button, which leaves the app running. On Windows it means right clicking the tray icon and choosing Quit, not clicking the X on the window. A half quit is the single most common reason a correct config appears to do nothing.

## Confirm the server loaded

Open a new chat and look at the tools control in the composer. `crmsolid` should be listed as connected with a tool count:

```text
crmsolid: connected
tools: 62   resources: 21   prompts: 15
```

Then run the smoke test. Type `List my connected social accounts`, approve the call, and you should get one row per connected account. If the server is listed but every call fails, the key is wrong or revoked. If the server is not listed at all, the config file did not parse, which the failure modes table below covers.

## Approving tool calls

The first time Claude wants to call a CRM Solid tool, an approval prompt appears inline in the conversation, above the assistant's reply, naming the tool and showing the arguments it intends to send. You can allow that single call or allow the tool for the rest of the chat.

Approve reads freely. `crm_list_social_conversations`, `crm_list_social_messages`, `crm_social_inbox_summary` and `crm_social_post_stats` are annotated `readOnly` and cannot change anything. Read the arguments before approving a write. `crm_send_social_message` sends a real DM from your brand account, and it is annotated non-idempotent, so approving it twice sends it twice. It also marks an operator takeover, which pauses the AI agent on that contact so a bot does not talk over you. Every write returns a confirmation of what changed, never a data feed, so a write result you did not expect is a signal to stop and check.

## Run the three social prompts from the prompt picker

Prompts are pre-written workflows the server ships. In Claude Desktop they appear in the attachment menu (the plus button next to the message box) under the server name.

| Prompt | Arguments | What it does |
|---|---|---|
| `social-inbox-triage` | optional `platform` | Pulls the conversations still waiting on a reply, groups by platform and urgency, and proposes an order of work. |
| `weekly-content-plan` | optional `topic` | Combines your connected accounts, what is already queued and the last 30 days of posting into a plan for the coming week. |
| `dm-reply-draft` | `conversationId`, optional `tone` | Reads one thread and drafts a reply for you to approve before it sends. It never sends by itself. |

For `dm-reply-draft` you need a conversation id. Ask for the inbox first, take the `id` from the result (they are integers, for example `4821`), then run the prompt with that id and a `tone` of `friendly` (the default), `professional` or `urgent`. More patterns are in [social inbox recipes](./social-inbox-recipes.md) and [content scheduling recipes](./content-scheduling-recipes.md).

## Attach the four social resources

Resources are snapshots you pin into the conversation instead of asking the model to go fetch them. They come from the same attachment menu, listed under `crmsolid`.

| Resource | Contents |
|---|---|
| `crm://social/accounts` | Every connected platform account with its handle, time zone and daily post limit |
| `crm://social/inbox` | Unread totals per network plus the 20 most recently active conversations |
| `crm://social/posts/scheduled` | Everything queued to go out, soonest first |
| `crm://social/posts/published` | Recently published posts with their live URLs, plus anything that failed and why |

Attaching a resource is cheaper and more predictable than a tool call when you want the model to reason over the same data across several turns. Attach `crm://social/inbox` once, then ask three follow up questions about it, instead of triggering three separate list calls that may each return a different page. Tool calls stay the right choice when you need filters, paging or fresh data mid conversation.

## A read-only profile for a shared laptop

On a machine other people use, or during a demo, drop every write tool locally:

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

`--read-only` removes write tools in the local proxy before Claude Desktop ever sees the list, so `crm_send_social_message` and `crm_schedule_social_post` are absent rather than refused. `--tools social,posts` hides the contacts, deals, tasks, email and finance families as well. For a stronger guarantee, issue a second API key with only `social:read` and `posts:read` and use that key here: local flags protect against a confused assistant, key scopes protect against a copied config file. See [security and scopes](./security-and-scopes.md).

## Claude Desktop failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Server missing from the tools list, no error anywhere | Invalid JSON, almost always a trailing comma after the last entry or a smart quote pasted from a web page | Run the file through a JSON validator, or reopen it via Settings, Developer, Edit Config. Claude Desktop skips a config it cannot parse and does not tell you why. |
| Works in the terminal, fails in the app | Node is not on the PATH that GUI apps inherit. Launching from Finder or the Start menu does not read `~/.zshrc` or `~/.bashrc`, which is where nvm and Volta put Node | Use an absolute path for `command`, for example `/Users/you/.nvm/versions/node/v20.17.0/bin/npx` on macOS. Find it with `which npx` (macOS) or `where npx` (Windows). |
| Edited the config, nothing changed | The app was closed, not quit, so the old process kept running with the old config | Cmd+Q on macOS. Quit from the tray icon on Windows. Then relaunch. |
| Server connects, every call returns an auth error | Key revoked, truncated on paste, or still the literal `csk_live_...` placeholder | Reissue at [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) and paste the full value. |
| Some tools appear, others do not | The key is missing scopes, or `--tools` is filtering more than you meant | Check the key's scopes in the app and compare against [security and scopes](./security-and-scopes.md). |

More cases, including proxy and corporate network problems, are in [troubleshooting](./troubleshooting.md).

## Next steps

- [Tools reference](./tools-reference.md): arguments and return shapes for all 62 tools.
- [Social inbox recipes](./social-inbox-recipes.md): triage and reply workflows that keep a human in the loop.
- [Content scheduling recipes](./content-scheduling-recipes.md): scheduling, time zones and the `publishNow` rule.
- [Claude Code](./claude-code.md) and [Cursor](./cursor.md) if you also work in a terminal or an editor.
- [ChatGPT and other clients](./chatgpt-and-other-clients.md) for remote transport.
- [FAQ](./faq.md) and the [package README](../README.md).
