# MCP Server Troubleshooting: Fixing a CRM Solid Connection That Will Not Start

Most MCP server troubleshooting ends in one of four places: the config file has a syntax error, the client cannot find `npx`, Node is older than 20, or the API key is wrong or under-scoped. Work through the three isolation checks below first, because they tell you whether the fault is your key, your network or your client, and every symptom section after that assumes you know which one it is.

Every symptom below is written as symptom, cause, fix. Commands are safe to run as written.

## MCP server troubleshooting in three checks

Run these in a terminal, in order. The first one that fails is where your problem is.

```bash
node --version
npx -y @crmsolid/mcp-server --version
```

```bash
curl -sS -X POST https://api.crmsolid.com/mcp \
  -H "Authorization: Bearer $CRMSOLID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

```bash
CRMSOLID_API_KEY=csk_live_... npx -y @crmsolid/mcp-server
```

| Check | If it fails | Meaning |
|---|---|---|
| `node --version` below v20, or not found | Node problem | Install Node 20 or newer |
| `--version` prints nothing or errors | Package or network problem | See the npx and proxy sections |
| `curl` returns 401, 403 or a network error | Key or network problem | See the HTTP status sections |
| `curl` works but the client shows nothing | Client problem | See the config and PATH sections |

The third command starts the server on stdio and then appears to hang. That is correct behaviour: it is waiting for JSON-RPC on stdin. What matters is the stderr it prints before it waits. Press Ctrl+C to stop it.

## The server does not appear in the client's tool list

**Cause.** In order of how often we see it: the config file is not valid JSON, the config is in the wrong file, the client was not fully restarted, or the server crashed on startup and the client silently dropped it.

**Fix.** Validate the JSON first. A trailing comma after the last entry is the single most common cause, and most editors will not flag it.

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

Then quit the client completely and reopen it. Closing the window is not enough on macOS, and on Windows the client may stay in the tray. Finally, read the client's own MCP log, which records the stderr of every server it spawns. Paths per client are in [./claude-desktop.md](./claude-desktop.md), [./claude-code.md](./claude-code.md), [./cursor.md](./cursor.md) and [./chatgpt-and-other-clients.md](./chatgpt-and-other-clients.md).

## Windows backslash paths break the config

**Cause.** JSON treats `\` as an escape character, so `C:\Users\me\node.exe` is invalid JSON and the whole file fails to parse, taking every other server down with it.

**Fix.** Either double the backslashes or use forward slashes. Both work on Windows.

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "C:\\Program Files\\nodejs\\npx.cmd",
      "args": ["-y", "@crmsolid/mcp-server"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

```json
{
  "mcpServers": {
    "crmsolid": {
      "command": "C:/Program Files/nodejs/npx.cmd",
      "args": ["-y", "@crmsolid/mcp-server"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

## "command not found: npx" or "spawn npx ENOENT"

**Cause.** The client cannot find `npx` on its PATH. This is almost never a missing Node install. It is that GUI applications do not inherit the PATH from your shell profile. On macOS, an app launched from Finder or Spotlight gets the system PATH, not the one your `.zshrc` builds, so a Node installed by nvm, Homebrew or fnm is invisible to it. On Windows, an app started before you edited the user PATH keeps the old environment until you sign out and back in.

**Fix.** Give the client an absolute path instead of relying on PATH.

```bash
which npx
```

```powershell
(Get-Command npx).Source
```

Put the result in `command`. On Windows use `npx.cmd`, not `npx`. If you use nvm, point at a specific installed version rather than the `current` symlink, because the symlink moves when you switch versions and the client will not notice.

## Node is older than 20

**Cause.** The package is ESM and requires Node 20 or newer. On an older runtime it fails at import time, often with a syntax error that does not mention the version at all.

**Fix.** Run `node --version`. If it is below v20, upgrade. If you have several Node versions installed, remember that the version your terminal reports is not necessarily the one the GUI client spawns: check by putting the absolute path to a known-good Node's `npx` in `command`, as above.

## 401 unauthorized

**Cause.** The key is missing, malformed, revoked, or belongs to a different environment. A key that was pasted with a trailing space or a newline fails the same way as no key at all.

**Fix.** Confirm the key starts with `csk_live_` and has no whitespace around it. Re-run the `curl` isolation check with the key inline rather than from an environment variable, which rules out the variable not being set in the client's environment. Create a fresh key at [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) if in doubt: revoking and reissuing takes seconds and eliminates a whole class of guessing. Details on key handling are in [./security-and-scopes.md](./security-and-scopes.md).

## 403 forbidden on one tool while others work

**Cause.** The key authenticated fine but lacks the scope that tool requires. This is the expected shape of the error, not a bug. Reading DMs needs `social:read`, sending needs `social:write`, reading posts needs `posts:read`, writing posts needs `posts:write`. Cross-family recipes need more: creating a task needs `tasks:write`, assigning a contact needs `contacts:write`, and dashboard numbers need `analytics:read`.

**Fix.** Open the key in the panel and check its granted scopes against the tool you called. [./tools-reference.md](./tools-reference.md) lists the required scope for every tool. Scopes are granted per key, so the usual fix is a second, wider key for the workflow that needs it, rather than widening the key your assistant uses all day.

## 429 rate limited

**Cause.** Too many calls in too short a window on that key. It shows up most often when an assistant loops over a long conversation list and fetches messages for each one without a limit.

**Fix.** Retry after a pause. Then remove the cause: put a `limit` in your prompt (1 to 100, default 25), ask for one platform at a time instead of all twelve, and let the assistant walk message history with `beforeMessageId` rather than pulling everything at once. Current limits are published on [https://crmsolid.com/public-api](https://crmsolid.com/public-api).

## A tool is in the docs but not in the client's tool list

**Cause.** A local filter removed it before your client ever saw the list. Either `--read-only` (or `CRMSOLID_READ_ONLY`) is on, which drops every write tool, or `--tools` (or `CRMSOLID_TOOLS`) is set to a family list that excludes it.

**Fix.** Look at the `args` in your config. `--tools social,posts` means contacts, deals, tasks, email and finance tools are not listed and not callable. Widen the list or remove the flag, then restart the client. This filter runs in the local proxy, so nothing about your key or your plan is involved.

```jsonc
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

## The conversation list comes back empty

**Cause.** No social account is connected to the workspace behind that key, or all conversations are filtered out by the arguments used. A `count` of 0 with an empty `conversations` array is a real answer, not an error.

**Fix.** Ask the assistant to call `crm_list_social_accounts` first. If that returns nothing, connect an account in the CRM Solid panel: the MCP server never holds platform credentials itself, so there is nothing to fix on your machine. If accounts exist but conversations do not, drop the filters and retry without `status` or `platform` before assuming something is broken.

## The first call times out

**Cause.** `npx -y` downloads the package on first use. On a slow or filtered connection that can exceed the client's startup timeout, and the client reports the server as failed even though the download eventually finishes.

**Fix.** Warm the cache in a terminal, then start the client. The second start is fast because the package is local.

```bash
npx -y @crmsolid/mcp-server --version
```

## An old version keeps loading after an update

**Cause.** The npx cache is holding a previous release.

**Fix.** Clear it, or pin the version explicitly so there is nothing to guess.

```bash
npx clear-npx-cache
npx -y @crmsolid/mcp-server@latest --version
```

```powershell
Remove-Item -Recurse -Force "$env:LOCALAPPDATA\npm-cache\_npx"
```

```jsonc
{
  "mcpServers": {
    "crmsolid": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server@<version>", "--tools", "social,posts"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

Pinning is the right default on a shared or production machine. Published versions are listed on [https://www.npmjs.com/package/@crmsolid/mcp-server](https://www.npmjs.com/package/@crmsolid/mcp-server).

## Corporate proxy or TLS interception

**Cause.** On a managed network, an inspecting proxy presents its own certificate. Node rejects it, and you get `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN`, or a plain socket timeout to `api.crmsolid.com`.

**Fix.** Give Node the corporate root certificate and give npm the proxy, at the machine level, not inside the MCP config.

```bash
export NODE_EXTRA_CA_CERTS=/path/to/corporate-root.pem
npm config set proxy http://proxy.internal:8080
npm config set https-proxy http://proxy.internal:8080
```

Do not disable certificate verification to get past this. If the certificate cannot be installed, ask your network team to allow `api.crmsolid.com` and `registry.npmjs.org` through without inspection.

## Getting diagnostics worth reading

1. `npx -y @crmsolid/mcp-server --version` proves the package installs and runs.
2. Running the binary by hand shows the stderr your client swallows. Start it with your key set and read what it prints before it waits on stdin.
3. The client's MCP log records spawn failures, exit codes and stderr for every server. It is the only place a crash-on-startup is visible.
4. `npx -y @crmsolid/mcp-server --help` lists the flags the installed version actually supports, which is more reliable than any document when you are chasing a version mismatch.

## Opening an issue

If none of the above fixes it, open an issue at [https://github.com/CRM-Solid/crmsolid-mcp/issues](https://github.com/CRM-Solid/crmsolid-mcp/issues) and include:

1. Output of `node --version` and `npx -y @crmsolid/mcp-server --version`.
2. Operating system and version, and the client plus its version.
3. Your config block with the key redacted to `csk_live_REDACTED`. Never paste a live key into a public issue. If you already have, revoke it first.
4. The exact stderr from running the server by hand, and the relevant lines from the client's MCP log.
5. The tool name and arguments that failed, and the full error including the HTTP status.
6. Which of the three isolation checks passed and which failed.
7. Whether `--read-only` or `--tools` is set.

That set is usually enough to answer without a round trip. See also [./faq.md](./faq.md), [./getting-started.md](./getting-started.md) and [../README.md](../README.md).
