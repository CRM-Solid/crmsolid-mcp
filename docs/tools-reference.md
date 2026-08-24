# MCP Tools for Social Media: Complete CRM Solid Tool Reference

The CRM Solid MCP server publishes 13 MCP tools for social media: 7 that drive the DM inbox (accounts, conversations, messages, send, mark read, inbox summary) and 6 that drive posts (list, get, schedule, update, cancel, stats). They sit alongside the 49 CRM tools that already shipped, so a single connection gives an assistant contacts, deals, tasks, email, finance, analytics and the whole social surface. Run the server locally over stdio with `npx -y @crmsolid/mcp-server`, or point a remote client at the hosted endpoint `POST https://api.crmsolid.com/mcp`. Twelve platforms are reachable: Instagram, Facebook, X (Twitter), LinkedIn, TikTok, YouTube, Threads, Pinterest, Reddit, Bluesky, Telegram and WhatsApp.

Two casing rules, stated once: MCP tool output is camelCase, and the public v1 REST API at `https://api.crmsolid.com/v1` is PascalCase. Same data, two surfaces, never mixed inside one payload. Every example on this page is MCP output, so every key here is camelCase.

Every id on this surface is an integer. Conversations, messages, posts, accounts and contacts are all numeric, and they arrive as JSON numbers rather than quoted strings. The one string identifier you will see is `externalAccountId`, which is the id the upstream network uses, not a CRM Solid id.

If you have not installed the server yet, start at [getting started](./getting-started.md), then the client page you need: [Claude Desktop](./claude-desktop.md), [Claude Code](./claude-code.md), [Cursor](./cursor.md), or [ChatGPT and other clients](./chatgpt-and-other-clients.md).

## What the MCP tools for social media cover

| Tool | Scope | Read or write | Purpose |
|---|---|---|---|
| `crm_list_social_accounts` | `social:read` | read | List the connected social accounts and their platforms |
| `crm_list_social_conversations` | `social:read` | read | List DM threads, filtered by platform, status, contact or unread |
| `crm_get_social_conversation` | `social:read` | read | Fetch one thread with its participant, status and last 10 messages |
| `crm_list_social_messages` | `social:read` | read | Walk the messages inside one thread |
| `crm_send_social_message` | `social:write` | write | Send a DM into an existing thread |
| `crm_mark_social_conversation_read` | `social:write` | write | Clear the unread counter on a thread |
| `crm_social_inbox_summary` | `social:read` | read | Counts across the whole inbox, broken down by platform |
| `crm_list_social_posts` | `posts:read` | read | List pending, published, failed and cancelled posts |
| `crm_get_social_post` | `posts:read` | read | Fetch one post by id |
| `crm_schedule_social_post` | `posts:write` | write | Schedule a post, or publish now on an explicit flag |
| `crm_update_social_post` | `posts:write` | write | Edit content, timing or media on a pending post |
| `crm_cancel_social_post` | `posts:write` | write | Cancel a post that has not gone out yet |
| `crm_social_post_stats` | `posts:read` | read | Publishing outcome counts over a window of days |

No tool in this list both reads and writes. A write tool answers with a confirmation of what changed, never with a data feed. That split is the reason a model cannot be talked into exfiltrating your inbox through a send call, and it is covered in detail in [security and scopes](./security-and-scopes.md).

Three status vocabularies run through everything below, and they are worth learning once. A conversation is `active` or `archived`. A post is `pending`, `processing`, `published`, `failed` or `cancelled`. A message has a `direction` of `inbound` or `outbound`. Nothing on this surface is ever "open", "closed" or "draft".

## crm_list_social_accounts

Lists the social accounts connected to the workspace, with the platform and the handle the assistant should quote when it talks about "your Instagram" or "your LinkedIn page". Most workflows begin here, because `accountIds` on a post refers to these ids.

| Argument | Type | Required | Description |
|---|---|---|---|
| `platform` | string | no | Filter to one network, for example `instagram` |
| `includeInactive` | boolean | no | Include disconnected or paused accounts; defaults to false |

```json
{
  "name": "crm_list_social_accounts",
  "arguments": {}
}
```

```json
{
  "count": 2,
  "accounts": [
    {
      "id": 12,
      "externalAccountId": "acc_zx91",
      "platform": "instagram",
      "provider": "zernio",
      "displayName": "Studio Kavun",
      "username": "studiokavun",
      "isActive": true,
      "timeZone": "Europe/Istanbul",
      "dailyPostLimit": 10,
      "connectedAt": "2026-05-02T11:24:08Z"
    },
    {
      "id": 15,
      "externalAccountId": "acc_qr47",
      "platform": "linkedin",
      "provider": "zernio",
      "displayName": "Studio Kavun",
      "username": "studio-kavun",
      "isActive": true,
      "timeZone": "Europe/Istanbul",
      "dailyPostLimit": 5,
      "connectedAt": "2026-06-18T09:05:41Z"
    }
  ]
}
```

Notes: the default hides accounts that are no longer active, so pass `includeInactive: true` when an assistant needs to explain why a platform disappeared rather than silently dropping it. `id` is the CRM Solid account id, and it is what `accountIds` expects on a schedule call. `externalAccountId` is the upstream id and is a string. `dailyPostLimit` is enforced at schedule time, so it is worth reading before planning a busy day.

## crm_list_social_conversations

Lists DM threads across every connected platform, most recently active first. This is the tool an assistant reaches for when you ask "what came in overnight" or "show me the active Instagram threads".

| Argument | Type | Required | Description |
|---|---|---|---|
| `platform` | string | no | One of the 12 platform slugs, for example `instagram`, `linkedin`, `x` |
| `status` | string | no | `active` or `archived`; omit for both |
| `contactId` | integer | no | Restrict to the thread bridged to one CRM contact |
| `unreadOnly` | boolean | no | Only threads with unread messages; defaults to false |
| `limit` | integer | no | 1 to 100, default 25 |

```json
{
  "name": "crm_list_social_conversations",
  "arguments": {
    "platform": "instagram",
    "status": "active",
    "unreadOnly": true,
    "limit": 25
  }
}
```

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

Notes: results are ordered newest activity first and capped by `limit`, so there is no page-two call to make; see [paging the MCP surface](#paging-the-mcp-surface-limit-and-beforemessageid) below for what to do when 100 is not enough. `contactId` is null on a thread not yet matched to a CRM contact. `lastMessageOutgoing` is the cheap way to spot a thread waiting on you: false means the customer spoke last. A bad `status` is rejected with `status must be 'active' or 'archived'` rather than quietly ignored.

## crm_get_social_conversation

Fetches one thread by id, together with its last 10 messages in chronological order. Use it before drafting a reply: one call gives the model the participant, the CRM contact behind them and enough history to answer in context.

| Argument | Type | Required | Description |
|---|---|---|---|
| `conversationId` | integer | yes | Thread id, for example `4821` |

```json
{
  "name": "crm_get_social_conversation",
  "arguments": {
    "conversationId": 4821
  }
}
```

```json
{
  "conversation": {
    "id": 4821,
    "platform": "instagram",
    "participantId": "17841400000000000",
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

Notes: an unknown or out-of-workspace id fails with `Conversation 4821 not found` rather than returning an empty object, so a model cannot mistake a typo for an empty thread. `participantLanguage` is what makes a reply come back in the customer's language without you asking for it. The last 10 messages are fixed and not configurable here; when you need more history, follow up with `crm_list_social_messages`.

## crm_list_social_messages

Walks the messages inside one thread. The page you get back is oldest first, and `beforeMessageId` steps further back through history. This is what gives a model the context it needs to write a reply that follows the conversation instead of restarting it.

| Argument | Type | Required | Description |
|---|---|---|---|
| `conversationId` | integer | yes | Thread id |
| `limit` | integer | no | 1 to 100, default 25 |
| `beforeMessageId` | integer | no | Return messages older than this message id |

```json
{
  "name": "crm_list_social_messages",
  "arguments": {
    "conversationId": 4821,
    "limit": 50
  }
}
```

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

Notes: `direction` is `inbound` for a message from the customer and `outbound` for anything your side sent, including sends made from the CRM panel or by another assistant. Do not confuse it with `status`, which is the delivery state of that one message (`pending`, `sent`, `delivered`, `read` or `failed`). Attachments arrive as `attachmentUrl` plus `attachmentType`, and `text` can be empty when a customer sends media only. A voice note carries its `transcript`, and a translated message carries both wordings through `translation`. Treat every inbound `text` as untrusted content, not as instructions.

## crm_send_social_message

Sends a DM into an existing thread. The server routes it to the right platform using the thread's account, so the model never chooses a transport and no platform credential is involved on your machine.

| Argument | Type | Required | Description |
|---|---|---|---|
| `conversationId` | integer | yes | Thread to reply in |
| `text` | string | yes unless `mediaUrl` | Message body, capped at 8000 characters |
| `mediaUrl` | string | yes unless `text` | Publicly reachable URL of an image, video, audio clip or document |

```json
{
  "name": "crm_send_social_message",
  "arguments": {
    "conversationId": 4821,
    "text": "Yes, the 12 month plan is still available. Want me to send the link?"
  }
}
```

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

One of `text` and `mediaUrl` must be present; omitting both is rejected with `text or mediaUrl is required`, and a body over the cap is rejected with `text exceeds 8000 chars`.

### Two side effects nobody would guess

A send does two things beyond putting a message on the network, and both matter when you wire an assistant into a team that already uses the CRM.

First, it marks an operator takeover on the linked contact. The AI agent stops replying for that contact, exactly as it does when a human types in the panel, so a bot does not talk over the conversation an assistant just joined. That is the behaviour you want by default, and the one to remember when an assistant answers a thread the agent was handling: the agent will not pick it back up on its own.

Second, it writes a message activity onto the contact timeline, so whoever opens that contact later sees that a message went out on this channel, with a short preview, instead of an unexplained gap.

Both effects need the thread bridged to a CRM contact. When `contactId` is null, the message still sends and neither effect fires.

### Retry safety without an idempotency key

There is no `idempotencyKey` argument on this tool, so the honest advice differs from the usual "generate a key" line. Three things protect you instead.

The tool is annotated as a write, destructive and open world, which is the strongest signal MCP gives a client. Clients that honour annotations (Claude Desktop and Claude Code both do) prompt before running it, so a send is a decision a human makes rather than something that happens inside a retry loop. Keep that prompt on.

A rejection comes back as an error, not as a silent success a client might feel obliged to retry. If the platform refuses the message, you get a sentence naming the reason and nothing was delivered.

And marking read is naturally repeatable: `crm_mark_social_conversation_read` leaves the same end state however often it runs. So the triage loop of read, reply, mark read has exactly one step a human should approve, and the rest costs nothing to repeat.

If you are integrating in code rather than through an assistant and you need a key that makes an automated retry safe, use the v1 REST endpoint instead: `POST /v1/social/conversations/{id}/messages` accepts an `IdempotencyKey` in its body, documented at [crmsolid.com/public-api](https://crmsolid.com/public-api).

Notes: platform reply windows still apply, and a send into a thread the platform has closed fails with a readable error naming the window, for example `The platform rejected this message: outside the 24 hour window (code 10)`. WhatsApp is the strict one at 24 hours from the customer's last message.

## crm_mark_social_conversation_read

Clears the unread counter on a thread. Use it after an assistant has actually handled a thread, so the human inbox reflects reality rather than showing work that is already done.

| Argument | Type | Required | Description |
|---|---|---|---|
| `conversationId` | integer | yes | Thread to mark read |

```json
{
  "name": "crm_mark_social_conversation_read",
  "arguments": {
    "conversationId": 4821
  }
}
```

```json
{
  "conversationId": 4821,
  "unreadCount": 0,
  "message": "Conversation marked read."
}
```

Notes: idempotent, and safe to repeat. Calling it on a thread that is already read returns the same confirmation and changes nothing. It is annotated open world as well as idempotent, because the mark travels to the network too where the network supports it: the provider zeroes its own unread state, and WhatsApp turns the ticks blue. That upstream step is best effort, so the local counter clears even when the platform call does not land.

## crm_social_inbox_summary

Returns counts across the whole inbox in one call, which is much cheaper than listing every thread to count them. Good first tool for a morning triage prompt, and the one tool here that answers "where should I start" without any arguments at all.

| Argument | Type | Required | Description |
|---|---|---|---|
| (none) | | | The tool takes no arguments |

```json
{
  "name": "crm_social_inbox_summary",
  "arguments": {}
}
```

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
    { "platform": "instagram", "conversations": 71, "unreadConversations": 7, "unreadMessages": 12, "lastMessageAt": "2026-08-24T08:41:12Z" },
    { "platform": "linkedin", "conversations": 38, "unreadConversations": 3, "unreadMessages": 5, "lastMessageAt": "2026-08-24T07:55:03Z" }
  ],
  "awaitingReply": [
    { "conversationId": 4821, "platform": "instagram", "participantName": "Dilara K.", "contactId": 91043, "unreadCount": 2, "lastMessageAt": "2026-08-24T08:41:12Z", "lastMessagePreview": "is the 12 month plan still available?" }
  ]
}
```

Notes: the numbers above are an example, not a benchmark. `awaitingReply` is the part worth putting in a triage prompt: it holds at most 10 active threads that are unread or where the customer spoke last, oldest first, so the model gets a queue rather than a statistic. `platforms` only lists platforms with at least one conversation, ordered by unread volume.

## crm_list_social_posts

Lists posts by state, platform and a date window. There is no draft state to filter for: a post that exists is already committed to a time.

| Argument | Type | Required | Description |
|---|---|---|---|
| `status` | string | no | `pending`, `processing`, `published`, `failed` or `cancelled` |
| `platform` | string | no | Platform slug, for example `linkedin` |
| `fromDate` | string | no | ISO 8601; only posts scheduled at or after this instant |
| `toDate` | string | no | ISO 8601; only posts scheduled at or before this instant |
| `limit` | integer | no | 1 to 100, default 25 |

```json
{
  "name": "crm_list_social_posts",
  "arguments": {
    "status": "pending",
    "fromDate": "2026-08-24T00:00:00Z",
    "toDate": "2026-08-31T00:00:00Z",
    "limit": 20
  }
}
```

```json
{
  "count": 1,
  "posts": [
    {
      "id": 993,
      "platform": "linkedin",
      "externalAccountId": "acc_zx91",
      "content": "Three things we learned migrating 40 support inboxes.",
      "scheduledAt": "2026-08-26T06:00:00Z",
      "status": "pending",
      "publishedUrl": null,
      "errorMessage": null,
      "publishedAt": null
    }
  ]
}
```

Notes: the window arguments are `fromDate` and `toDate`, not `from` and `to`, and both filter on the scheduled time rather than the publish time. Results are ordered by scheduled time, newest first. `content` is truncated to 400 characters in the list, so use `crm_get_social_post` when the model needs the full body. `errorMessage` carries the reason on a `failed` post, which is what lets an assistant explain a miss instead of just reporting one. A bad status is rejected with `status must be one of pending|processing|published|failed|cancelled`.

## crm_get_social_post

Fetches one post by id, with the full untruncated content. Use it before an update or a cancel so the model works from current state rather than from a list it fetched earlier in the conversation.

| Argument | Type | Required | Description |
|---|---|---|---|
| `postId` | integer | yes | Post id, for example `993` |

```json
{
  "name": "crm_get_social_post",
  "arguments": {
    "postId": 993
  }
}
```

```json
{
  "id": 993,
  "platform": "linkedin",
  "externalAccountId": "acc_zx91",
  "content": "Three things we learned migrating 40 support inboxes.",
  "mediaUrls": [],
  "scheduledAt": "2026-08-26T06:00:00Z",
  "status": "pending",
  "externalPostId": null,
  "publishedUrl": null,
  "errorMessage": null,
  "retryCount": 0,
  "createdAt": "2026-08-24T10:02:55Z",
  "publishedAt": null
}
```

Notes: a post that has gone out carries `status: "published"`, an `externalPostId` and a `publishedUrl` you can quote back to a human. Once it is published, `crm_update_social_post` and `crm_cancel_social_post` no longer apply to it, which is the rule described under cancel below. `retryCount` is how many times the scheduler has already tried, and it is the field to read before blaming the content for a failure.

## crm_schedule_social_post

Creates a post on one or more connected accounts. This is the write that people worry about most, so the default is deliberately timid.

**`scheduledAt` is required unless you pass `publishNow: true`. Omitting both is an error, not a draft.** There is no draft status anywhere on this surface. A model that says "post this" without saying when gets `scheduledAt is required unless publishNow is true` back and has to come to you for a decision. Nothing reaches an audience except on an explicit time or an explicit `publishNow`.

| Argument | Type | Required | Description |
|---|---|---|---|
| `content` | string | yes unless `mediaUrls` | Post body |
| `platforms` | string[] | yes | Target platform slugs, for example `["linkedin", "x"]` |
| `accountIds` | integer[] | no | Narrow the fan out to specific accounts; defaults to every connected account on the named platforms |
| `scheduledAt` | string | yes unless `publishNow` | ISO 8601 publish time, must be in the future |
| `mediaUrls` | string[] | no | Publicly reachable image or video URLs |
| `timeZone` | string | no | IANA zone used to read a `scheduledAt` that carries no offset, for example `Europe/Istanbul` |
| `publishNow` | boolean | no | Publish immediately instead of scheduling; defaults to false |

```json
{
  "name": "crm_schedule_social_post",
  "arguments": {
    "content": "Three things we learned migrating 40 support inboxes.",
    "platforms": ["linkedin", "x"],
    "accountIds": [12, 15],
    "scheduledAt": "2026-08-26T09:00:00",
    "timeZone": "Europe/Istanbul"
  }
}
```

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

### The rules the server enforces before it writes anything

One post row is created per target account. Two platforms means two posts, which is why the response returns `postIds` as an array rather than a single id. Update and cancel then operate on one row at a time, so changing the LinkedIn copy leaves the X copy alone.

A single call may fan out to at most 20 target accounts. Ask for more and you get `At most 20 target accounts per call` before any row exists.

Every target's daily post limit is checked before a single post is written, so a fan out cannot half succeed on a quota you could already have seen: either the whole batch is created, or the call fails with `Daily post limit (10) reached for instagram account 12` and nothing was scheduled. `dailyPostLimit` comes back on every row from `crm_list_social_accounts`, so an assistant can check its own plan before proposing it.

Time is resolved once, for the whole batch, and the response always echoes the instant it stored in UTC. There are two supported ways to say which clock you mean, and exactly one way to get it wrong:

| What you send | What gets stored |
|---|---|
| `"scheduledAt": "2026-08-26T06:00:00Z"` | 06:00 UTC, `timeZone` ignored |
| `"scheduledAt": "2026-08-26T09:00:00+03:00"` | 06:00 UTC, `timeZone` ignored |
| `"scheduledAt": "2026-08-26T09:00:00"` with `"timeZone": "Europe/Istanbul"` | 06:00 UTC, converted from the zone |
| `"scheduledAt": "2026-08-26T09:00:00"` with no `timeZone` | 09:00 UTC, the bare value is read as UTC |

**Be explicit in one of the two ways.** An offset on `scheduledAt` wins outright, and a wall clock value with no offset is read in `timeZone`, which is exactly what that field is for. Being explicit in neither is the whole "the post went out at the wrong hour" bug: a bare `09:00:00` with no zone publishes at noon in Istanbul, not at nine. `timeZone` is validated as an IANA zone id on entry, and an unrecognised one gives `timeZone must be a valid IANA zone id, e.g. 'Europe/Istanbul'`. Daylight saving moves the offset, not the zone name, which is the second reason to pass the zone rather than a hand computed offset for a date months out.

Notes: annotated destructive and open world, because a scheduled post eventually leaves for a third party. `skipped` is null on a clean run and carries per account reasons when some targets failed while others succeeded, so a partial fan out is visible rather than silent. Per platform content rules are enforced at creation, and a body that breaks one is rejected with the platform named: TikTok and YouTube require a video, Instagram and Pinterest require an image or a video, an Instagram caption caps at 2200 characters, LinkedIn at 3000, and X at 280. Worked recipes live in [content scheduling recipes](./content-scheduling-recipes.md).

## crm_update_social_post

Edits a post that has not gone out. Every argument except `postId` is optional, and only the fields you pass are touched.

| Argument | Type | Required | Description |
|---|---|---|---|
| `postId` | integer | yes | Post to edit |
| `content` | string | no | Replacement body |
| `scheduledAt` | string | no | New ISO 8601 publish time, must be in the future |
| `mediaUrls` | string[] | no | Replacement media list |
| `timeZone` | string | no | IANA zone used to read a `scheduledAt` that carries no offset |

```json
{
  "name": "crm_update_social_post",
  "arguments": {
    "postId": 993,
    "scheduledAt": "2026-08-27T06:00:00Z"
  }
}
```

```json
{
  "postId": 993,
  "platform": "linkedin",
  "scheduledAt": "2026-08-27T06:00:00Z",
  "status": "pending",
  "message": "Post updated."
}
```

Notes: only a `pending` post is editable. Anything already published, in flight, failed or cancelled is refused with `Post 993 not found, or it is no longer editable (only pending posts can be edited)`, which deliberately does not distinguish a missing post from a locked one. There is no `platforms` argument here: the target account was fixed when the row was created, so retargeting means cancelling and scheduling again. Passing `mediaUrls` replaces the whole array rather than appending to it, which is the behaviour to spell out in a prompt if you want a model to add one image: it must send the full list. Passing none of `content`, `scheduledAt` or `mediaUrls` is rejected with `Nothing to update: supply content, scheduledAt or mediaUrls`. Idempotent, so replaying the same update is harmless.

## crm_cancel_social_post

Cancels a post that has not been published. The post stays in the CRM with `status: "cancelled"` so the history is intact and the assistant can explain what happened.

| Argument | Type | Required | Description |
|---|---|---|---|
| `postId` | integer | yes | Post to cancel |

```json
{
  "name": "crm_cancel_social_post",
  "arguments": {
    "postId": 993
  }
}
```

```json
{
  "postId": 993,
  "platform": "linkedin",
  "status": "cancelled",
  "message": "Post cancelled; it will not be published."
}
```

### Cancel is not delete

The server never deletes a post that already went out upstream. Cancel only affects a post that has not been published, which on this surface means a pending or a failed one whose time has passed or not yet arrived. Once a post is live on LinkedIn or Instagram, cancelling it in CRM Solid would give you a false record, and reaching into the platform to remove it is not something an assistant should be able to do from a chat window. Call `crm_cancel_social_post` on a published post and it is refused with `This post is already published; the copy on the network cannot be withdrawn from here`. To take down a live post, remove it on the platform, or from the social scheduler in the CRM Solid panel where a human confirms the action.

Notes: safe to repeat. Cancelling a post that is already cancelled succeeds and says so, answering `Post was already cancelled.` instead of failing, so a retry after a dropped connection costs nothing. Remember that `postIds` from a schedule call is an array: cancelling a two platform fan out is two calls, one per id.

## crm_social_post_stats

Aggregates publishing outcomes over a window, so an assistant can answer "did everything go out last month" in one call instead of listing posts and adding them up.

| Argument | Type | Required | Description |
|---|---|---|---|
| `days` | integer | no | Size of the window in days, 1 to 365, default 30 |

```json
{
  "name": "crm_social_post_stats",
  "arguments": {
    "days": 30
  }
}
```

```json
{
  "days": 30,
  "from": "2026-07-25T09:12:00Z",
  "to": "2026-08-24T09:12:00Z",
  "total": 34,
  "published": 24,
  "pending": 6,
  "processing": 0,
  "failed": 3,
  "cancelled": 1,
  "lastPublishedAt": "2026-08-23T06:00:00Z",
  "platforms": [
    { "platform": "linkedin", "total": 14, "published": 11, "pending": 2, "failed": 1, "cancelled": 0 },
    { "platform": "x", "total": 12, "published": 9, "pending": 2, "failed": 1, "cancelled": 0 }
  ]
}
```

Notes: the figures above are illustrative. This tool counts publishing outcomes and nothing else. There are no impressions, no engagements and no reach anywhere in the payload, because CRM Solid does not pull per post analytics back from the networks. It answers "what went out and what failed", not "how did it perform"; for the latter, hand over the `publishedUrl` from `crm_get_social_post` and point at the network's own insights. The window is measured on scheduled time, so a post scheduled inside it but still pending counts toward `total` and `pending`. `lastPublishedAt` is the fastest way to spot a scheduler that has quietly stopped: a date several days old beside a healthy `pending` count is the signature.

## Paging the MCP surface: limit and beforeMessageId

MCP list tools do not use cursor pagination. There is no `after` argument, no `items` wrapper, no `nextCursor` and no `hasMore` anywhere on this surface. Each list tool takes a `limit` between 1 and 100 (default 25) and answers with a named array plus a `count`. That is the whole contract, and it is a deliberate fit for how assistants work: a model that can page forever will, and it will spend your context window doing it. When you want fewer results, narrow the filters, since `platform`, `status`, `unreadOnly` and `contactId` all cut the result set before `limit` does.

Message history is the one place you genuinely need to walk backwards, and `crm_list_social_messages` has `beforeMessageId` for it. Ask for a page, take the lowest `id` you received, and pass it back as `beforeMessageId` to get the messages older than it.

First call, the most recent slice of the thread:

```json
{
  "name": "crm_list_social_messages",
  "arguments": {
    "conversationId": 4821,
    "limit": 2
  }
}
```

```json
{
  "conversationId": 4821,
  "platform": "instagram",
  "count": 2,
  "messages": [
    {
      "id": 88212,
      "direction": "outbound",
      "senderName": "Support",
      "text": "Hi Dilara, how can we help?",
      "attachmentUrl": null,
      "attachmentType": null,
      "transcript": null,
      "translation": null,
      "status": "read",
      "sentAt": "2026-08-24T08:39:40Z"
    },
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

Second call, older than the lowest id from the first page (`88212`):

```json
{
  "name": "crm_list_social_messages",
  "arguments": {
    "conversationId": 4821,
    "limit": 2,
    "beforeMessageId": 88212
  }
}
```

```json
{
  "conversationId": 4821,
  "platform": "instagram",
  "count": 1,
  "messages": [
    {
      "id": 88209,
      "direction": "inbound",
      "senderName": "Dilara K.",
      "text": "hello, are you open on Sunday?",
      "attachmentUrl": null,
      "attachmentType": null,
      "transcript": null,
      "translation": null,
      "status": "read",
      "sentAt": "2026-08-19T14:02:55Z"
    }
  ]
}
```

A `count` lower than the `limit` you asked for means you have reached the start of the thread. Stop there. Two habits worth putting in a system prompt: never loop without a stop condition, and prefer `crm_social_inbox_summary` over listing threads when all you need is a count.

Cursor pagination does exist, but it belongs to the v1 REST API, not to MCP. There, `?after=<id>` returns an envelope of `items`, `nextCursor` and `hasMore`, and you walk it until `hasMore` is false. That is the surface to reach for when you are writing code against a large workspace rather than driving an assistant, and it is documented at [crmsolid.com/public-api](https://crmsolid.com/public-api). Do not send `after` to an MCP tool: it is not in the schema, so it is ignored rather than honoured.

## Error handling: scope failures, rate limits and the write rule

The v1 REST API returns a Stripe-style envelope. It is PascalCase like the rest of v1, and it names the error class, a human sentence, and optional details:

```json
{
  "Error": "not_found",
  "Message": "Conversation 4821 was not found in this workspace.",
  "Details": null
}
```

Over MCP, a failure inside a tool is not a protocol error. It comes back as a normal tool result with `isError: true` and a single text block carrying the server's own sentence, which is what lets the model read it and tell you what to fix:

```json
{
  "content": [
    { "type": "text", "text": "scheduledAt is required unless publishNow is true" }
  ],
  "isError": true
}
```

Those sentences are written to be acted on, so none of them need an error table. `text or mediaUrl is required` and `text exceeds 8000 chars` name the argument to change. `Post 993 not found, or it is no longer editable (only pending posts can be edited)` and `This post is already published; the copy on the network cannot be withdrawn from here` name the state that blocked the write. `The platform rejected this message: outside the 24 hour window (code 10)` names the platform's rule and its code.

A **scope failure** is different, and it is the one you will hit most often, because it happens the moment a key is missing a scope the tool needs. It never reaches the tool at all, so it arrives as a JSON-RPC error with code `-32002`:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32002,
    "message": "Tool 'crm_send_social_message' requires scope 'social:write'",
    "data": {
      "requiredScope": "social:write",
      "granted": ["social:read", "posts:read"]
    }
  }
}
```

`data.requiredScope` is the actionable field and `data.granted` shows what the key actually carries, so the gap is visible without a second call. Add exactly that scope to the key at `https://app.crmsolid.com/settings/developers`, then restart the MCP server so it re-reads the key. Code `-32001` is the neighbouring case: the key itself is missing, malformed, revoked or expired.

A **rate limit** is a 429 from the public API with a `Retry-After` header in seconds:

```json
{
  "error": "rate_limit_exceeded",
  "message": "Per-minute request budget exhausted for this API key"
}
```

Limits are per API key, which is another argument for one key per client rather than one key shared across a team. The proxy retries a 429 a small number of times using the server's `Retry-After` value before it gives up and reports the wait to the model.

Two rules govern everything above:

1. A write tool returns a confirmation of what changed, never a data feed. `crm_send_social_message` returns the ids of the one message it sent. `crm_cancel_social_post` returns the one post it cancelled. There is no argument, filter or prompt that turns a write tool into a reader, so a model that has been talked into calling a write tool cannot use it to extract your inbox.
2. A domain failure (a closed reply window, a body too long for X, a post that is already published) is a tool result with `isError: true`, not a protocol error. Reserve the JSON-RPC error codes in your head for auth and scope problems, which are the two things restarting the server or editing the key will fix.

For symptoms rather than shapes, see [troubleshooting](./troubleshooting.md).

## Resources and prompts: 4 URIs and 3 named prompts

Resources are read-only documents the client can attach as context without spending a tool call. Reach for a resource when you want the model to *have* the data before it starts reasoning, and for a tool when the model needs to *ask a question* with filters.

| Resource URI | Returns |
|---|---|
| `crm://social/accounts` | Every connected account with handle, time zone and daily post limit, so the model can pick an account without calling `crm_list_social_accounts` first |
| `crm://social/inbox` | Unread totals per network plus the 20 most recently active DM threads with participant, preview and unread count |
| `crm://social/posts/scheduled` | Posts queued to go out, soonest first, with network, scheduled time and a content preview |
| `crm://social/posts/published` | The most recently published posts with their live URLs, plus any that failed and why |

All four require the matching read scope (`social:read` for the first two, `posts:read` for the last two). A client that supports resource attachment (Claude Desktop does; support elsewhere varies, see [ChatGPT and other clients](./chatgpt-and-other-clients.md)) can pin `crm://social/inbox` into a conversation so every question about the inbox starts from current state.

| Prompt | Arguments | What it does |
|---|---|---|
| `social-inbox-triage` | optional `platform` | Pulls the threads still waiting on a reply and ranks who to answer first and why; pass a platform to triage one network |
| `weekly-content-plan` | optional `topic` | Combines the connected accounts, what is already scheduled and the last 30 days of posting into a plan for the coming week |
| `dm-reply-draft` | `conversationId`, optional `tone` | Reads one thread and drafts a reply in the participant's language, at the platform's usual length |

Prompts are starting points that already know the tool names and the safety rules, which saves you writing them into a system prompt. `dm-reply-draft` drafts and never sends; `tone` accepts `friendly` (the default), `professional` or `urgent`, and `conversationId` is the numeric id from a list call. `weekly-content-plan` proposes a plan for you to approve, it does not schedule anything: the scheduling stays a separate, annotated call.

## Tool families beyond social

The same server and the same key expose the CRM. Use `--tools` (or `CRMSOLID_TOOLS`) with a comma-separated list to narrow what a client sees; the filter runs in the local proxy, so a filtered tool is neither listed nor callable from that client.

| Family | `--tools` value | What it covers | Example tools |
|---|---|---|---|
| Social DMs | `social` | Accounts, conversations, messages, inbox summary | `crm_list_social_conversations`, `crm_send_social_message` |
| Social posts | `posts` | Scheduling, publishing, cancelling, outcome stats | `crm_schedule_social_post`, `crm_social_post_stats` |
| Contacts | `contacts` | Search, notes, tags, lead score, stage | `crm_search_contacts`, `crm_get_contact`, `crm_tag_contact`, `crm_set_lead_score` |
| Deals | `deals` | Pipeline value, creation, stage moves | `crm_list_deals`, `crm_create_deal`, `crm_update_deal_stage` |
| Tasks | `tasks` | Task list, creation, completion | `crm_list_tasks`, `crm_create_task`, `crm_complete_task` |
| Email | `email` | Thread search, thread reads, status changes | `crm_search_email_threads`, `crm_get_email_thread`, `crm_set_email_thread_status` |
| Finance | `finance` | Revenue summary, invoices, transactions | `crm_finance_summary`, `crm_list_invoices`, `crm_list_transactions` |
| Analytics | `analytics` | Dashboard rollups, messaging stats, top contacts | `crm_dashboard_summary`, `crm_messaging_stats`, `crm_top_contacts` |
| Sequences | `sequences` | Campaign status, pause and resume | `crm_list_sequences`, `crm_get_sequence_status` |
| Pipelines | `pipelines` | Board and stage definitions | `crm_list_pipelines`, `crm_get_pipeline` |
| Jobs | `jobs` | Queued and completed background work | `crm_list_jobs`, `crm_get_job` |
| Webhooks | `webhooks` | Subscriptions and delivery history | `crm_list_webhooks`, `crm_list_webhook_deliveries` |
| Agents | `agents` | The AI agents configured in your workspace | `crm_list_agents`, `crm_run_agent` |

A DM responder that has no business reading invoices is one flag away:

```bash
npx -y @crmsolid/mcp-server --tools social
```

Add `--read-only` to drop every write tool before the client ever sees the list. Both flags are local filters and are a guard against a confused model, not against a stolen key. The scope on the key is the real boundary, and that distinction is the subject of [security and scopes](./security-and-scopes.md).

## Next steps

- Work through the inbox patterns in [social inbox recipes](./social-inbox-recipes.md): triage, draft, approve, send, mark read.
- Build a publishing routine with [content scheduling recipes](./content-scheduling-recipes.md), including the approve-then-schedule workflow.
- Set least-privilege keys with [security and scopes](./security-and-scopes.md).
- Fix a client that lists no tools with [troubleshooting](./troubleshooting.md).
- Short answers to common questions are in the [FAQ](./faq.md), and the package overview is in the [README](../README.md).

The REST surface these tools wrap is documented at [crmsolid.com/public-api](https://crmsolid.com/public-api), the package is on [npm](https://www.npmjs.com/package/@crmsolid/mcp-server), and the protocol itself is specified at [modelcontextprotocol.io](https://modelcontextprotocol.io).
