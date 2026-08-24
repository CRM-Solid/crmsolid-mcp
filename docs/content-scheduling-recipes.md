# Schedule Social Posts With AI: Content Recipes for MCP Clients

To schedule social posts with AI, connect the CRM Solid MCP server to your assistant and let it put dated posts on the calendar, which you then review and move. The six recipes below cover a full month of work: planning a week, cross-posting one idea, auditing the calendar, moving things around a launch, mining your DMs for topics, and reviewing what actually went out.

**`scheduledAt` is required unless `publishNow: true` is passed. Leave out both and the call is rejected with `scheduledAt is required unless publishNow is true`, and nothing is created.** That single rule is why it is safe to let a model touch your calendar at all: an assistant that forgets to say when gets a rejection, never a surprise publish. It is repeated in every recipe below where it matters.

MCP tool output is camelCase (`scheduledAt`). The public v1 REST API is PascalCase (`ScheduledAt`). These recipes only use the MCP tools, so everything you see here is camelCase.

## What you need to schedule social posts with AI

| Requirement | Where |
|---|---|
| Server installed in your client | [./getting-started.md](./getting-started.md) |
| API key with `posts:read` and `posts:write` | [https://app.crmsolid.com/settings/developers](https://app.crmsolid.com/settings/developers) |
| Social accounts connected in the panel | CRM Solid panel, Social settings |
| Recipes 5 and 6 also need `social:read` and `analytics:read` | [./security-and-scopes.md](./security-and-scopes.md) |

```jsonc
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

## 1. Plan a week and land five queued posts, not five publishes

**Goal:** finish Monday morning with five posts sitting on next week's calendar and nothing published.

```text
Run the weekly-content-plan prompt for next week. Give me five
ideas for LinkedIn and X. Show me the times you propose, then
schedule each one with scheduledAt. Never pass publishNow.
```

Tools the assistant runs:

1. `weekly-content-plan` (prompt, optional `topic`)
2. `crm_list_social_accounts`
3. `crm_schedule_social_post` with `content`, `platforms` and `scheduledAt`, once per idea

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

Check `status` on every confirmation. A queued post comes back `pending`, and it turns `processing` and then `published` only when its moment arrives. **A call with neither `scheduledAt` nor `publishNow: true` is rejected, not queued and not published. Immediate publication requires `publishNow: true`, and nothing else triggers it.** If a confirmation comes back with a `status` you did not expect, the prompt asked for something you did not intend, and the fix is the prompt, not the calendar.

`crm_list_social_accounts` runs first because `accountIds` decides which of your connected accounts a post goes to. Skip it and the assistant guesses when you have more than one account per platform. One post is created per target account, up to 20 per call, and each account's daily post limit is checked before anything is written, which is why the confirmation hands back `postIds` as an array and why a fan out cannot half succeed on a quota you could already see.

**Make it a habit:** run it at the same hour every Monday and always end the prompt with "never pass publishNow". A saved prompt with that sentence baked in is the cheapest guard rail in this document.

## 2. Cross-post one idea with per-platform edits

**Goal:** one idea, several platforms, each version written for its audience.

```text
Take post 993. Schedule the same copy for LinkedIn and X on
26 August at 09:00 UTC. Then rewrite the X version to fit 280
characters with no hashtags, and update just that post.
```

Tools the assistant runs:

1. `crm_get_social_post` with `postId`
2. `crm_schedule_social_post` with `content`, `platforms`, `accountIds` and a `scheduledAt` that carries `Z` or an offset
3. `crm_update_social_post` with `postId` and `content`

```json
{
  "count": 2,
  "postIds": [993, 994],
  "platforms": ["linkedin", "x"],
  "scheduledAt": "2026-08-26T09:00:00Z",
  "status": "pending",
  "skipped": null,
  "message": "Scheduled on 2 account(s) for 2026-08-26 09:00 UTC."
}
```

A `platforms` array is the fast path for one idea, but it does not make one row: the server creates a post per target account and returns every id in `postIds`, so two platforms means two entries on the calendar and two things to cancel later. That is what makes the per-platform rewrite easy. Point `crm_update_social_post` at 994 on its own and the LinkedIn copy in 993 is untouched, because the tool edits one post, not a platform variant inside a shared one.

The rule of thumb we use: if the difference is length or hashtags, keep one wording and accept the compromise. If the difference is the hook or the call to action, rewrite the second post.

`crm_update_social_post` is idempotent. Running the same update twice leaves the post in the same state, so a retry after a timeout is safe. It only reaches a `pending` post, though: once something has gone out, the server answers that the post is no longer editable.

**Make it a habit:** end every cross-post prompt with "show me the final text per platform before you save". Reading two versions takes ten seconds and catches the case where the assistant improved the LinkedIn copy while it was in there.

## 3. Review the calendar for gaps and collisions

**Goal:** see the next two weeks as a list, find the empty days and the pile-ups.

```text
List everything queued from 25 August to 8 September. Show them as a
table by date and platform. Tell me which weekdays have nothing and
which slots have two or more posts within two hours.
```

Tools the assistant runs:

1. `crm_list_social_posts` with `status=pending`, `fromDate`, `toDate` and `limit`
2. `crm_get_social_post` with `postId`, only for anything that looks wrong

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

The date arguments are `fromDate` and `toDate`, not `from` and `to`, and the tool returns a `count` and a `posts` array bounded by `limit` (1 to 100, default 25). Two weeks of posts usually fits inside the default, but if `count` comes back equal to the `limit` that was asked for, assume there is more and either raise it or narrow the range. A truncated calendar that looks complete is the worst outcome of this recipe, so ask the assistant to state the `count` and the range it used. The list also truncates `content` at 400 characters, which is what step 2 is for.

Collisions matter more than gaps. Two posts to the same account inside an hour compete with each other, and on most networks the second one loses.

**Make it a habit:** run it every Friday for the following two weeks. Pair it with recipe 1 so the plan you write on Monday fills the holes you found on Friday.

## 4. Reschedule around a launch or an incident

**Goal:** move or stop everything that should not run today, in one pass.

```text
We have an incident. List everything queued for the next 48
hours. Cancel the two promotional posts, and move the rest to the
same times next week. Confirm each change before you make it.
```

Tools the assistant runs:

1. `crm_list_social_posts` with `status=pending`, `fromDate` and `toDate`
2. `crm_cancel_social_post` with `postId`, for anything that should not run
3. `crm_update_social_post` with `postId` and a new `scheduledAt`, for anything that only moves

```json
{
  "postId": 993,
  "platform": "linkedin",
  "status": "cancelled",
  "message": "Post cancelled; it will not be published."
}
```

Cancel and move are different actions and the assistant will happily do the wrong one, so name them separately in the prompt. `crm_cancel_social_post` is idempotent: cancelling an already cancelled post is not an error, which makes a half finished incident pass safe to re-run.

The hard limit: **a post that has already gone out is never deleted upstream.** Cancelling stops a `pending` post from publishing. Aim it at something already published and the server answers "This post is already published; the copy on the network cannot be withdrawn from here". No tool in this server reaches into Instagram or LinkedIn to remove a live post. If something is already public and has to come down, remove it in the platform's own app or in the CRM Solid panel.

For a launch, run the same recipe in reverse: cancel nothing, move the surrounding posts out of the launch window, and leave a clear hour on either side of the announcement.

**Make it a habit:** write the incident version of this prompt now, while nothing is on fire, and keep it where the on-call person can find it. Nobody composes a good prompt during an outage.

## 5. Turn a customer DM into a post idea

**Goal:** the questions customers actually ask become the posts you actually write.

```text
Read the active Instagram conversations from the last seven days.
Find the three questions that came up most often. Write one post
per question for Instagram and LinkedIn. Show me the copy first,
and only schedule it once I say the wording is right.
```

Tools the assistant runs:

1. `crm_list_social_conversations` with `platform=instagram` and `status=active`
2. `crm_list_social_messages` with `conversationId`, per conversation
3. `crm_schedule_social_post` with `content`, `platforms` and `scheduledAt`, once per approved idea

```json
{
  "count": 2,
  "postIds": [993, 994],
  "platforms": ["instagram", "linkedin"],
  "scheduledAt": "2026-09-01T06:00:00Z",
  "status": "pending",
  "skipped": null,
  "message": "Scheduled on 2 account(s) for 2026-09-01 06:00 UTC."
}
```

Keeping the wording turn and the scheduling turn apart is the whole discipline here. The server will not let a post through without a time anyway, so the copy review is the only step you have to enforce yourself.

This recipe needs `social:read` on top of `posts:write`, because it crosses two tool families. It is the strongest argument for running one server with both families exposed rather than two narrow ones.

Do not let a real customer's words go out verbatim. Repeat the question, not the person. The prompt above asks for the question that came up most often, which naturally strips the individual out of it.

**Make it a habit:** run it fortnightly, right after a triage pass from [./social-inbox-recipes.md](./social-inbox-recipes.md), when the inbox is already loaded and fresh in your head.

## 6. Monthly review, and what to change next month

**Goal:** decide next month's cadence from what actually published, rather than from feel.

```text
Give me post stats for the last 30 days and the dashboard summary.
Then tell me: which platform published the most, where the failures
are, how even the cadence was, and what one change I should make
next month.
```

Tools the assistant runs:

1. `crm_social_post_stats` with `days=30`
2. `crm_dashboard_summary`
3. `crm_list_social_posts` with `status=published`, `fromDate` and `toDate`, when you want to name the specific posts

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

Read that for what it is: a publishing reliability and cadence review. `crm_social_post_stats` counts outcomes, so it tells you how much went out, how much is still queued and how much failed, per platform. It carries no impressions, no reach and no engagement, and no tool in this server exposes network level performance. Three failed posts in a month is a real finding you can act on. "Which post performed best" is a question for the network's own analytics.

`crm_social_post_stats` defaults to 30 days and accepts 1 to 365, so `days` is optional here. Pass `days=7` when you want a weekly pulse instead.

Ask for exactly one change. A review that produces six changes produces zero, because next month cannot tell you which of the six worked. Change the posting hour, or the cadence, or the platform mix. Not all three.

**Make it a habit:** run it on the first working day of the month and paste the one change into the top of your weekly planning prompt from recipe 1. That is the loop: plan, publish, measure, adjust one thing.

## Time zones: `timeZone` is IANA, `scheduledAt` is UTC

Mixing these up is the most common scheduling bug we see, and it is silent: the post publishes, just not when you meant, and you find out from a timestamp that says 4am.

There are two supported ways to say which clock you mean, and exactly one way to get it wrong:

| What you send | What gets stored |
|---|---|
| `"scheduledAt": "2026-08-26T06:00:00Z"` | 06:00 UTC, `timeZone` ignored |
| `"scheduledAt": "2026-08-26T09:00:00+03:00"` | 06:00 UTC, `timeZone` ignored |
| `"scheduledAt": "2026-08-26T09:00:00"` with `"timeZone": "Europe/Istanbul"` | 06:00 UTC, converted from the zone |
| `"scheduledAt": "2026-08-26T09:00:00"` with no `timeZone` | 09:00 UTC, the bare value is read as UTC |

Rules that keep it straight:

1. Be explicit in one of the two ways. An offset on `scheduledAt` wins outright, and a bare wall clock is read in `timeZone`. Being explicit in neither is the bug: `2026-08-26T09:00:00` with no zone publishes at noon in Istanbul, not at nine.
2. Never write `Europe/Istanbul` style names into `scheduledAt`, and never write `+03:00` or `EST` into `timeZone`. `EST` and `PST` are not IANA identifiers and are ambiguous across daylight saving anyway.
3. Say the time zone out loud in your prompt. "Tuesday 9am Istanbul time" gives the assistant something to convert or to pass through as `timeZone`. "Tuesday 9am" gives it something to guess.
4. Check the confirmation, not the request. The returned `scheduledAt` is what will happen, in UTC.
5. For a date months out, prefer the zone over a hand computed offset. Daylight saving moves the offset, not the zone name: Istanbul is `+03:00` all year, but 09:00 in New York is `-05:00` in January and `-04:00` in June.

A quick sanity test after any bulk scheduling: list the affected range with `crm_list_social_posts` and read the `scheduledAt` values as UTC. If your 09:00 Istanbul posts show `06:00:00Z`, the conversion landed. If they show `09:00:00Z`, a bare wall clock went up with no zone beside it and every one of them is three hours late.

## Next

- [./social-inbox-recipes.md](./social-inbox-recipes.md) for the DM side of the same server
- [./tools-reference.md](./tools-reference.md) for every argument on every post tool
- [./security-and-scopes.md](./security-and-scopes.md) for `posts:write` and read-only keys
- [./troubleshooting.md](./troubleshooting.md) if a tool is missing or a call fails
- [./faq.md](./faq.md), [./chatgpt-and-other-clients.md](./chatgpt-and-other-clients.md), [../README.md](../README.md)
