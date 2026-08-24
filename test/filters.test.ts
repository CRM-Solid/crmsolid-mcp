import { afterEach, describe, expect, it } from 'vitest';

import { ToolNotAllowedError } from '../src/core/errors.js';
import {
  KNOWN_GROUPS,
  assertToolAllowed,
  filterTools,
  isReadOnlyTool,
  parseGroups,
  toolGroup,
  unknownGroups,
} from '../src/filters.js';
import {
  CRM_TOOLS,
  SOCIAL_TOOLS,
  connectBridge,
  tool,
  toolsRoute,
  type ConnectedBridge,
} from './helpers.js';

let session: ConnectedBridge | null = null;

afterEach(async () => {
  await session?.close();
  session = null;
});

describe('tool group inference', () => {
  it('splits the frozen social surface into social and posts', () => {
    // Names overlap on purpose: a post tool is also a social tool. The contract
    // splits them by scope, so the post rules have to win.
    expect(toolGroup('crm_list_social_accounts')).toBe('social');
    expect(toolGroup('crm_list_social_conversations')).toBe('social');
    expect(toolGroup('crm_get_social_conversation')).toBe('social');
    expect(toolGroup('crm_list_social_messages')).toBe('social');
    expect(toolGroup('crm_send_social_message')).toBe('social');
    expect(toolGroup('crm_mark_social_conversation_read')).toBe('social');
    expect(toolGroup('crm_social_inbox_summary')).toBe('social');

    expect(toolGroup('crm_list_social_posts')).toBe('posts');
    expect(toolGroup('crm_get_social_post')).toBe('posts');
    expect(toolGroup('crm_schedule_social_post')).toBe('posts');
    expect(toolGroup('crm_update_social_post')).toBe('posts');
    expect(toolGroup('crm_cancel_social_post')).toBe('posts');
    expect(toolGroup('crm_social_post_stats')).toBe('posts');
  });

  it('classifies the existing CRM tools', () => {
    const expected: Record<string, string> = {
      crm_search_contacts: 'contacts',
      crm_tag_contact: 'contacts',
      crm_set_lead_score: 'contacts',
      crm_create_tag: 'contacts',
      crm_get_conversation: 'conversations',
      crm_list_recent_conversations: 'conversations',
      crm_create_deal: 'deals',
      crm_update_deal_stage: 'deals',
      crm_complete_task: 'tasks',
      crm_search_email_threads: 'email',
      crm_finance_summary: 'finance',
      crm_list_invoices: 'finance',
      crm_revenue_sources_summary: 'finance',
      crm_pause_sequence: 'sequences',
      crm_get_pipeline: 'pipelines',
      crm_create_webhook: 'webhooks',
      crm_get_job: 'jobs',
      crm_run_agent: 'agents',
      crm_list_accounts: 'accounts',
      crm_send_telegram_message: 'telegram',
      crm_send_twitter_dm: 'twitter',
      crm_dashboard_summary: 'analytics',
      crm_messaging_stats: 'analytics',
    };

    for (const [name, group] of Object.entries(expected)) {
      expect(`${name} -> ${toolGroup(name)}`).toBe(`${name} -> ${group}`);
    }
  });

  it('returns null for a tool no rule recognises', () => {
    expect(toolGroup('crm_something_nobody_shipped_yet')).toBeNull();
  });

  it('parses and validates the flag value', () => {
    expect(parseGroups('social,posts')).toEqual(['social', 'posts']);
    expect(parseGroups(' Social , POSTS , social ')).toEqual(['social', 'posts']);
    // An empty value means "no filter", not "expose nothing".
    expect(parseGroups('')).toBeNull();
    expect(parseGroups('   ')).toBeNull();
    expect(parseGroups(undefined)).toBeNull();

    expect(unknownGroups(['social', 'sozial'])).toEqual(['sozial']);
    expect(unknownGroups(null)).toEqual([]);
    expect(KNOWN_GROUPS).toContain('social');
    expect(KNOWN_GROUPS).toContain('posts');
  });
});

describe('filterTools', () => {
  const all = [...SOCIAL_TOOLS, ...CRM_TOOLS];

  it('keeps everything when no filter is set', () => {
    expect(filterTools(all, { groups: null, readOnly: false })).toHaveLength(all.length);
  });

  it('keeps only the named groups', () => {
    const kept = filterTools(all, { groups: ['social'], readOnly: false }).map((entry) => entry.name);
    expect(kept).toEqual([
      'crm_list_social_accounts',
      'crm_list_social_conversations',
      'crm_get_social_conversation',
      'crm_list_social_messages',
      'crm_send_social_message',
      'crm_mark_social_conversation_read',
      'crm_social_inbox_summary',
    ]);
  });

  it('accepts several groups at once', () => {
    const kept = filterTools(all, { groups: ['social', 'posts'], readOnly: false });
    expect(kept).toHaveLength(SOCIAL_TOOLS.length);
    expect(kept.map((entry) => entry.name)).not.toContain('crm_search_contacts');
  });

  it('hides a tool whose group no rule recognises when a filter is set', () => {
    // Fail closed. A tool shipped after this build was published is exactly the
    // case where "the user asked for social only" has to win.
    const unknownTool = tool('crm_brand_new_surface', true);
    const kept = filterTools([...all, unknownTool], { groups: ['social'], readOnly: false });
    expect(kept.map((entry) => entry.name)).not.toContain('crm_brand_new_surface');

    // With no filter it is exposed like anything else.
    const unfiltered = filterTools([unknownTool], { groups: null, readOnly: false });
    expect(unfiltered).toHaveLength(1);
  });
});

describe('read-only classification', () => {
  it('treats anything but an explicit readOnlyHint as a write', () => {
    expect(isReadOnlyTool({ annotations: { readOnlyHint: true } })).toBe(true);
    expect(isReadOnlyTool({ annotations: { readOnlyHint: false } })).toBe(false);
    // "The server did not say" is not a safe basis for sending a customer a DM.
    expect(isReadOnlyTool({ annotations: {} })).toBe(false);
    expect(isReadOnlyTool({})).toBe(false);
    expect(isReadOnlyTool({ annotations: { title: 'x', idempotentHint: true } })).toBe(false);
  });
});

describe('assertToolAllowed', () => {
  it('refuses a name the upstream list does not carry', () => {
    expect(() => assertToolAllowed('crm_made_up', undefined, { groups: null, readOnly: false })).toThrow(
      ToolNotAllowedError,
    );
  });

  it('names the group in the refusal so the user knows which flag to change', () => {
    const target = tool('crm_create_deal', false);
    try {
      assertToolAllowed(target.name, target, { groups: ['social'], readOnly: false });
      expect.unreachable('the call should have been refused');
    } catch (error) {
      expect(error).toBeInstanceOf(ToolNotAllowedError);
      expect((error as Error).message).toContain('--tools social');
      expect((error as Error).message).toContain("'deals' group");
    }
  });
});

describe('--tools over the wire', () => {
  it('exposes only the named groups in tools/list', async () => {
    session = await connectBridge(
      { routes: { 'tools/list': toolsRoute([...SOCIAL_TOOLS, ...CRM_TOOLS]) } },
      { toolGroups: ['social', 'posts'] },
    );

    const listed = await session.client.listTools();
    expect(listed.tools).toHaveLength(SOCIAL_TOOLS.length);
    expect(listed.tools.map((entry) => entry.name)).not.toContain('crm_finance_summary');
  });

  it('refuses a filtered-out tool that is called anyway', async () => {
    // Hiding a tool from the list is advice; a model that saw the name in an
    // earlier turn can still call it, so the call path enforces the filter too.
    session = await connectBridge(
      {
        routes: {
          'tools/list': toolsRoute([...SOCIAL_TOOLS, ...CRM_TOOLS]),
          'tools/call': { result: { content: [{ type: 'text', text: 'should never run' }] } },
        },
      },
      { toolGroups: ['social'] },
    );

    const result = await session.client.callTool({ name: 'crm_create_deal', arguments: {} });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('--tools social');
    // The refusal is local: nothing reached the API.
    expect(session.upstream.received('tools/call')).toHaveLength(0);
  });
});

describe('--read-only over the wire', () => {
  it('lists only tools annotated readOnlyHint', async () => {
    session = await connectBridge({ routes: { 'tools/list': toolsRoute(SOCIAL_TOOLS) } }, { readOnly: true });

    const listed = await session.client.listTools();
    expect(listed.tools.map((entry) => entry.name)).toEqual([
      'crm_list_social_accounts',
      'crm_list_social_conversations',
      'crm_get_social_conversation',
      'crm_list_social_messages',
      'crm_social_inbox_summary',
      'crm_list_social_posts',
      'crm_get_social_post',
      'crm_social_post_stats',
    ]);
  });

  it('refuses a write that is called anyway, without reaching the API', async () => {
    session = await connectBridge(
      {
        routes: {
          'tools/list': toolsRoute(SOCIAL_TOOLS),
          'tools/call': { result: { content: [{ type: 'text', text: 'DM sent' }] } },
        },
      },
      { readOnly: true },
    );

    const result = await session.client.callTool({
      name: 'crm_send_social_message',
      arguments: { conversationId: 12, text: 'hello' },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('--read-only');
    expect(session.upstream.received('tools/call')).toHaveLength(0);
  });

  it('still allows a read', async () => {
    session = await connectBridge(
      {
        routes: {
          'tools/list': toolsRoute(SOCIAL_TOOLS),
          'tools/call': { result: { content: [{ type: 'text', text: '3 unread' }], isError: false } },
        },
      },
      { readOnly: true },
    );

    const result = await session.client.callTool({ name: 'crm_social_inbox_summary', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(textOf(result)).toBe('3 unread');
  });

  it('fetches the tool list on demand when a call arrives before any list', async () => {
    // A client is free to call a tool it learned about in an earlier session.
    // The annotations still have to be known before the read-only gate can run.
    session = await connectBridge(
      {
        routes: {
          'tools/list': toolsRoute(SOCIAL_TOOLS),
          'tools/call': { result: { content: [{ type: 'text', text: 'never' }] } },
        },
      },
      { readOnly: true },
    );

    const result = await session.client.callTool({ name: 'crm_cancel_social_post', arguments: { postId: 1 } });

    expect(session.upstream.received('tools/list')).toHaveLength(1);
    expect(result.isError).toBe(true);
  });
});

/** Joins the text blocks of a tool result. */
function textOf(result: unknown): string {
  const content = (result as { content?: unknown } | null)?.content;
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate?.type === 'text' && typeof candidate.text === 'string';
    })
    .map((block) => block.text)
    .join('\n');
}
