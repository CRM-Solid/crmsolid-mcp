# Manage Instagram DMs With AI: Social Inbox Recipes for MCP Clients

To manage Instagram DMs with AI, point your MCP client at the CRM Solid server, ask for a triage summary, and approve every reply before it leaves. The six recipes below are the ones our support team runs daily. Each gives you the prompt to type, the tools the assistant calls in order, the shape of the data that comes back, and a way to turn it into a routine instead of a one-off.

Everything here works the same on Instagram, WhatsApp, LinkedIn, X and the other platforms CRM Solid connects, because every direct message lands in one inbox and one set of tools.

Two conventions to keep straight before you start. MCP tool output is camelCase (`lastMessageAt`). The public v1 REST API is PascalCase (`LastMessageAt`). You only see the REST shape if you call the HTTP API directly, which these recipes do not.

## Before you manage Instagram DMs with AI

| Requirement | Where |
|---|---|
| Server installed in your client | [./getting-started.md](./getting-started.md) |
| API key with `social:read` and `social:write` | [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) |
| At least one social account connected in the panel | CRM Solid panel, Social settings |
| Client specific setup | [./claude-desktop.md](./claude-desktop.md), [./claude-code.md](./claude-code.md), [./cursor.md](./cursor.md), [./chatgpt-and-other-clients.md](./chatgpt-and-other-clients.md) |

A minimal configuration, which every recipe below assumes:

```jsonc
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

If a tool named in a recipe is missing from your client's tool list, check the `--tools` filter and `--read-only` first. See [./troubleshooting.md](./troubleshooting.md).

## 1. Morning triage across every platform

**Goal:** know what is waiting for you across all twelve platforms in under a minute.

```text
Run the social-inbox-triage prompt. Then list active conversations,
group them by platform, and tell me which ones have been waiting
longest. Do not reply to anything yet.
```

Tools the assistant runs:

1. `social-inbox-triage` (prompt, optional `platform` argument)
2. `crm_social_inbox_summary`
3. `crm_list_social_conversations` with `status=active`

The summary comes back first and is small enough to read yourself:

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

`awaitingReply` holds at most ten conversations, oldest first, which is the queue you actually work. The list call returns a `count` and a `conversations` array, bounded by `limit` (1 to 100, default 25). Set `limit` yourself when you want a short answer: `limit=20` is usually enough for a morning pass, and 100 is the ceiling.

**Make it a habit:** save this as a starred or pinned prompt in your client and run it as the first thing you do. In Claude Code you can commit it as a slash command in the project so the whole team runs the same triage. The `social-inbox-triage` prompt is served by the server, so it stays current when we improve it, without you editing anything.

## 2. Draft a reply that sounds like you, then send it

**Goal:** a reply in your voice, reviewed by you, sent once.

```text
Use the dm-reply-draft prompt for conversation 4821 with
tone friendly. Show me the draft and the last five messages that
led to it. Do not send.
```

Tools the assistant runs:

1. `crm_get_social_conversation` with `conversationId`
2. `crm_list_social_messages` with `conversationId` and `limit`
3. `dm-reply-draft` (prompt, arguments `conversationId` and optional `tone`: `friendly` by default, `professional` or `urgent`)

Read the draft. Change it. Then, and only then:

```text
Send that.
```

4. `crm_send_social_message` with `conversationId` and `text`

The write returns a confirmation of what changed, not a data feed:

```json
{
  "status": "sent",
  "messageId": 88214,
  "conversationId": 4821,
  "platform": "instagram",
  "contactId": 91043,
  "externalMessageId": "aWdfZG1fMTo...",
  "sentAt": "2026-08-24T09:02:41Z",
  "message": "Message sent on instagram to Dilara K."
}
```

Two side effects come with that send, and both are useful here. It marks an operator takeover, which pauses the AI agent on that contact so an automated reply cannot talk over you mid thread, and it writes a message activity to the contact timeline, so the rest of the team sees the answer in the CRM without you pasting anything across.

Two things carry the safety of this recipe. The first is the human review step: `dm-reply-draft` only drafts, never sends, so the assistant proposes, you edit, you approve. Splitting the draft turn from the send turn is what keeps a model from talking to your customer unsupervised. The second is the write annotation. `crm_send_social_message` is marked non-idempotent, so a client that honours annotations prompts you before it sends and shows the text it is about to put in the thread, and a platform rejection comes back as an error (`The platform rejected this message: outside the 24 hour window (code 10)`) rather than being retried silently. The MCP tool takes no idempotency key; if you are writing code that sends without a human in the turn, use the v1 REST endpoint, which does accept one: [https://crmsolid.com/public-api](https://crmsolid.com/public-api).

**Make it a habit:** keep the draft and the send as two separate messages, permanently. If you find yourself typing "draft and send it" in one line, you have removed the review step, and the tone argument becomes the only thing standing between a bad day and your customer.

## 3. Escalate refunds, cancellations and legal language

**Goal:** nothing with a refund, a cancellation or a lawyer in it sits in a DM inbox unowned.

```text
Look through active social conversations for anything mentioning
refunds, cancellation, chargeback, consumer arbitration or a
lawyer. For each one, create a high priority task due today and
assign the contact to me.
```

Tools the assistant runs:

1. `crm_list_social_conversations` with `status=active`
2. `crm_list_social_messages` for each candidate conversation
3. `crm_create_task` with `title`, `priority`, `dueAt` and `contactId`
4. `crm_assign_contact` with `contactId` and `assignedToUserId`

```json
{
  "id": 4471,
  "title": "Refund request from Dilara K. (instagram, conversation 4821)",
  "status": "Open",
  "priority": "High",
  "dueAt": "2026-08-24T15:00:00Z",
  "contactId": 91043,
  "dealId": null,
  "message": "Task #4471 created"
}
```

Two practical notes. `crm_create_task` needs `tasks:write` and `crm_assign_contact` needs `contacts:write`, so a key scoped only to `social:read` and `social:write` will get a 403 on step 3. Grant the extra scopes on the key you use for escalation work, or run escalation from a second, wider key. Scope behaviour is documented in [./security-and-scopes.md](./security-and-scopes.md).

The word list is yours to own. Ours grew from four words to eleven over a year, and the additions came from tasks we wished had existed, not from a template.

**Make it a habit:** run this immediately after the morning triage in recipe 1, on the same conversation list the assistant already loaded. That saves a second pass over the inbox and keeps escalation attached to the moment you actually looked at it.

## 4. Turn a DM into a CRM record

**Goal:** the useful part of a conversation ends up on the contact, not in your head.

```text
Read conversation 4821. Summarise what we learned about
this customer in under 400 characters, add it as a note, tag the
contact with "instagram-lead", and set the lead score to 70.
```

Tools the assistant runs:

1. `crm_get_social_conversation` with `conversationId`
2. `crm_list_social_messages` with `conversationId`
3. `crm_add_contact_note` with `contactId` and `note`
4. `crm_tag_contact` with `contactId` and `tagName`
5. `crm_set_lead_score` with `contactId` and `score`

```json
{
  "conversation": {
    "id": 4821,
    "platform": "instagram",
    "participantName": "Dilara K.",
    "participantUsername": "dilarak",
    "participantLanguage": "tr",
    "contactId": 91043,
    "unreadCount": 2,
    "status": "active",
    "lastMessageAt": "2026-08-24T08:41:12Z",
    "createdAt": "2026-08-19T14:02:55Z"
  },
  "messages": [
    {
      "id": 88213,
      "direction": "inbound",
      "senderName": "Dilara K.",
      "text": "is the 12 month plan still available?",
      "attachmentUrl": null,
      "attachmentType": null,
      "transcript": null,
      "translation": null,
      "status": "delivered",
      "sentAt": "2026-08-24T08:41:12Z"
    }
  ]
}
```

`crm_get_social_conversation` already carries the last ten messages, oldest first, so step 2 is only worth running when you need history older than that. The `contactId` on the conversation is the CRM contact, so the assistant carries it straight into steps 3 to 5 with no lookup.

Watch the note length. The contact note field holds 500 characters and appends: once it is full, the oldest text drops off the front. That is why the prompt caps the summary at 400 characters. If a contact needs more history than that, put it in a task or a deal, not in the note field.

`crm_tag_contact` attaches an existing tag and rejects a name that does not exist yet. Create your tag vocabulary once in the panel (or with `crm_create_tag`) and the assistant will stop inventing near-duplicates like `instagram_lead` next to `instagram-lead`.

**Make it a habit:** attach this to the end of any conversation that reaches a decision, won or lost. A saved prompt with the tag name and the score band already written in removes the two fields the model is most likely to guess.

## 5. Clear the unread backlog without losing anything

**Goal:** get unread down to zero by reading, not by hiding.

```text
For every conversation with unread messages on instagram, show me
the last three messages. After I confirm, mark the ones I list as
read.
```

Tools the assistant runs:

1. `crm_list_social_conversations` with `platform=instagram` and `unreadOnly=true`
2. `crm_list_social_messages` with `conversationId` and `limit=3`, once per conversation
3. `crm_mark_social_conversation_read` with `conversationId`, once per confirmed conversation

```json
{
  "conversationId": 4821,
  "platform": "instagram",
  "count": 1,
  "messages": [
    {
      "id": 88213,
      "direction": "inbound",
      "senderName": "Dilara K.",
      "text": "is the 12 month plan still available?",
      "attachmentUrl": null,
      "attachmentType": null,
      "transcript": null,
      "translation": null,
      "status": "delivered",
      "sentAt": "2026-08-24T08:41:12Z"
    }
  ]
}
```

`crm_mark_social_conversation_read` is annotated idempotent. Calling it twice on the same conversation has the same effect as calling it once (it answers `{ "conversationId": 4821, "unreadCount": 0 }` either way), so a retry after a dropped connection is safe and a partially completed batch can simply be re-run. That is the difference between it and `crm_send_social_message`, and it is why marking read is the one write in this document you can let the assistant repeat without thinking about duplicates.

Idempotent does not mean reversible. A conversation marked read is read for everyone on the team. The confirmation step in the prompt exists so a model does not clear a backlog you have not seen.

**Make it a habit:** run it per platform rather than across all twelve. A single Instagram pass with three messages of context is something you can actually read. An all-platform pass turns into a wall of text and gets approved without reading, which defeats the point.

## 6. End of day report

**Goal:** one paragraph, in the place your team already looks.

```text
Give me an end of day social report: inbox summary now, plus
messaging stats for the last 1 day. Six lines maximum, no bullet
points, and name the platform with the worst unread count.
```

Tools the assistant runs:

1. `crm_social_inbox_summary`
2. `crm_messaging_stats` with `windowDays=1`

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
  ]
}
```

The platform with the worst unread count is the one with the highest `unreadConversations`, so the per-platform line of the report comes from the summary, not from the stats call. `crm_messaging_stats` takes `windowDays` of 1, 7 or 30 (7 by default) and an optional `accountId`, and it answers from the outbound send queue: `totals` of queued, sent and failed, plus a `successRate`. Nothing per platform, and no response times, because how fast you replied is not exposed by these tools today. Use 1 for the daily note and 7 on Fridays.

Where the report goes depends on your client. In Claude Code, pipe the output into whatever posts to your team channel. In Claude Desktop or Cursor, copy it. Neither client posts to Slack on its own, and the CRM Solid server does not either: it reads and writes CRM data, nothing else.

**Make it a habit:** run it at a fixed time, and keep the six line cap. A report that grows stops being read within two weeks.

## When the model wants to send something you did not intend

Assume it will try, eventually. Four layers stop it, and you should have at least two on at any time.

1. **Client approval prompts.** Every MCP client asks before a tool call, but the granularity differs: some ask per call, some let you approve a tool for the session, some let you allow a whole server. Set yours to ask for each write and never blanket-approve `crm_send_social_message`. Client specifics are in [./claude-desktop.md](./claude-desktop.md), [./claude-code.md](./claude-code.md) and [./cursor.md](./cursor.md).
2. **A read-only key.** Create a second key with only `social:read` and `posts:read` at [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) and use it for research, drafting and reporting. A write attempt on that key fails at the API with 403, whatever the client decides locally.
3. **`--read-only`.** The flag drops every write tool in the local proxy before your client ever sees the list. A tool that is not listed cannot be called by a confused model, a jailbroken prompt or a bad paste.
4. **`--tools`.** `--tools social,posts` narrows the exposed surface to those families. The filter also runs locally, so a filtered tool is neither listed nor callable.

```jsonc
{
  "mcpServers": {
    "crmsolid-readonly": {
      "command": "npx",
      "args": ["-y", "@crmsolid/mcp-server", "--read-only", "--tools", "social,posts"],
      "env": { "CRMSOLID_API_KEY": "csk_live_..." }
    }
  }
}
```

One structural guarantee helps too: no tool both reads and writes. A write returns a confirmation of what changed, never a data feed, so a model cannot get information by sending a message. Full annotations per tool are in [./tools-reference.md](./tools-reference.md).

## One inbox, twelve platforms, twelve rule books

Instagram, Facebook, X (Twitter), LinkedIn, TikTok, YouTube, Threads, Pinterest, Reddit, Bluesky, Telegram and WhatsApp all land in the same inbox. The recipes above do not change per platform: `crm_list_social_conversations` with `platform=tiktok` behaves exactly like `platform=instagram`, and the JSON shape is identical.

What does change is what each platform allows. Several only permit a free-form reply inside a limited window after the customer's last message, and require a pre-approved template outside it. Some restrict automated or bulk outbound messaging outright. Rate limits, attachment types and link handling differ. These rules are set by the platforms, they change, and they are enforced on the account you connected, not on CRM Solid.

Two consequences worth planning for. If a platform rejects a send, the tool call returns an error rather than a silent success, so check the confirmation and do not assume delivery. And before you automate replies on any platform, read that platform's own developer and business messaging policy. An assistant that drafts and waits for approval is safe almost everywhere. An assistant that sends unattended is not, and the account at risk is yours.

## Next

- [./content-scheduling-recipes.md](./content-scheduling-recipes.md) for the posting side of the same server
- [./tools-reference.md](./tools-reference.md) for every argument on every tool
- [./security-and-scopes.md](./security-and-scopes.md) for scopes, keys and rotation
- [./faq.md](./faq.md) and [./troubleshooting.md](./troubleshooting.md) when something behaves oddly
- [../README.md](../README.md) for the package itself
