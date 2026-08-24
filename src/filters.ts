import { ToolNotAllowedError } from './core/errors.js';
import type { ToolInfo } from './upstream/types.js';

/**
 * Local surface filters, applied to every list before it leaves this process and
 * again on every call before it reaches the network.
 *
 * The filters exist because the remote key is coarse and the local context is
 * not. One `csk_live_...` key carries whatever scopes its owner gave it, but the
 * assistant sitting on the other end of stdio may only be trusted with part of
 * that: a content-planning session has no business sending DMs, and a research
 * session has no business writing at all. `--tools` and `--read-only` let the
 * person editing their MCP config narrow one key per client without minting a
 * second key.
 *
 * Both filters are enforced twice, and that is deliberate. Hiding a tool from
 * `tools/list` is advice; a model that saw the name once in an earlier turn can
 * still call it. The check in {@link assertToolAllowed} is the enforcement.
 */

/** Everything the filters need to know about the session's configuration. */
export interface FilterOptions {
  /** Group names to keep, already lower-cased. `null` keeps every group. */
  groups: string[] | null;
  /** When true, only tools annotated `readOnlyHint: true` survive. */
  readOnly: boolean;
}

/**
 * Group inference, ordered most specific first.
 *
 * The upstream tool list does not carry a group, only a name, so the group is
 * read off the name. Rules rather than a hardcoded table because the backend
 * adds tools continuously: a table would silently drop every tool shipped after
 * this package was published, which is the worst possible failure for a bridge.
 *
 * Order matters where names overlap. `crm_list_social_posts` and
 * `crm_social_post_stats` are both social AND posts; the contract splits them
 * on scope (`posts:read` / `posts:write` versus `social:*`), so the post rules
 * run first and win.
 */
const GROUP_RULES: ReadonlyArray<{ group: string; pattern: RegExp }> = [
  { group: 'posts', pattern: /_posts?(_|$)/ },
  { group: 'social', pattern: /_social(_|$)/ },
  { group: 'contacts', pattern: /_contacts?(_|$)|_tags?(_|$)|_lead_score(_|$)/ },
  { group: 'conversations', pattern: /_conversations?(_|$)/ },
  { group: 'deals', pattern: /_deals?(_|$)/ },
  { group: 'tasks', pattern: /_tasks?(_|$)/ },
  { group: 'email', pattern: /_email(_|$)/ },
  { group: 'finance', pattern: /_finance(_|$)|_invoices?(_|$)|_transactions?(_|$)|_revenue(_|$)/ },
  { group: 'sequences', pattern: /_sequences?(_|$)/ },
  { group: 'pipelines', pattern: /_pipelines?(_|$)/ },
  { group: 'webhooks', pattern: /_webhooks?(_|$)/ },
  { group: 'jobs', pattern: /_jobs?(_|$)/ },
  { group: 'agents', pattern: /_agents?(_|$)/ },
  { group: 'accounts', pattern: /_accounts?(_|$)/ },
  { group: 'telegram', pattern: /_telegram(_|$)/ },
  { group: 'twitter', pattern: /_twitter(_|$)/ },
  { group: 'analytics', pattern: /_dashboard(_|$)|_stats(_|$)|_summary(_|$)/ },
];

/** Groups a `--tools` value is expected to name. Used only to spell-check the flag. */
export const KNOWN_GROUPS: readonly string[] = GROUP_RULES.map((rule) => rule.group);

/**
 * The group a tool belongs to, or `null` when no rule matches.
 *
 * A `null` group is not an error. It means the backend shipped something this
 * build has never heard of, and the caller decides what that implies.
 */
export function toolGroup(name: string): string | null {
  // Rules match against `_name_`, so a group that ends the name and a group that
  // starts it are found by the same pattern.
  const padded = `_${name.replace(/^crm_/, '')}_`;
  for (const rule of GROUP_RULES) {
    if (rule.pattern.test(padded)) return rule.group;
  }
  return null;
}

/**
 * True when the tool declares itself read-only.
 *
 * Strictly `readOnlyHint === true`. A missing annotation block, a missing hint
 * and an explicit `false` all count as a write, because "the server did not say"
 * is not a safe basis for letting a model send a message to a customer.
 */
export function isReadOnlyTool(tool: Pick<ToolInfo, 'annotations'>): boolean {
  return tool.annotations?.readOnlyHint === true;
}

/** Why a tool is hidden, or `null` when it is allowed. */
export function toolRejection(tool: ToolInfo, options: FilterOptions): string | null {
  if (options.readOnly && !isReadOnlyTool(tool)) {
    return 'This session was started with --read-only, which allows only tools that CRM Solid marks as read-only.';
  }

  if (options.groups) {
    const group = toolGroup(tool.name);
    if (group === null) {
      return (
        `This session was started with --tools ${options.groups.join(',')}, and this tool ` +
        `does not belong to any of those groups.`
      );
    }
    if (!options.groups.includes(group)) {
      return (
        `This session was started with --tools ${options.groups.join(',')}, and this tool ` +
        `belongs to the '${group}' group.`
      );
    }
  }

  return null;
}

/** The subset of `tools` this session exposes. */
export function filterTools(tools: ToolInfo[], options: FilterOptions): ToolInfo[] {
  return tools.filter((tool) => toolRejection(tool, options) === null);
}

/**
 * Throws unless the tool may be called in this session.
 *
 * `undefined` for an unknown tool means the bridge could not find it in the
 * upstream list. Refusing is the right answer: either the name is wrong, or the
 * filter already removed it, and both end with the call not happening.
 */
export function assertToolAllowed(name: string, tool: ToolInfo | undefined, options: FilterOptions): void {
  if (!tool) {
    throw new ToolNotAllowedError({
      toolName: name,
      reason: 'CRM Solid does not publish a tool by that name to this API key.',
    });
  }
  const rejection = toolRejection(tool, options);
  if (rejection) throw new ToolNotAllowedError({ toolName: name, reason: rejection });
}

/**
 * Parses a `--tools` / CRMSOLID_TOOLS value into a group list.
 *
 * An empty or whitespace-only value means "no filter", not "no tools": a config
 * file that sets `CRMSOLID_TOOLS=""` should behave like one that never set it,
 * rather than exposing an empty tool list nobody can debug.
 */
export function parseGroups(value: string | undefined | null): string[] | null {
  if (typeof value !== 'string') return null;
  const groups = value
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
  return groups.length > 0 ? unique(groups) : null;
}

/** Group names in `groups` that no rule can ever produce, so a typo can be reported. */
export function unknownGroups(groups: string[] | null): string[] {
  if (!groups) return [];
  return groups.filter((group) => !KNOWN_GROUPS.includes(group));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
