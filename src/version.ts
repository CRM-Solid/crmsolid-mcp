/**
 * Package version, reported in `--version`, in the MCP `serverInfo` this bridge
 * advertises to the local client, and in the User-Agent sent upstream.
 *
 * Kept as a literal rather than read from package.json at runtime: the built
 * bundle is loaded by `npx` from wherever npm unpacked it, and resolving a
 * sibling package.json from a bundled ESM file is one more thing that can fail
 * in a user's environment for no benefit. CI checks it against package.json
 * before publishing, so the two cannot drift.
 */
export const VERSION = '0.1.0';

/** Machine name of this server, as it appears in the local `initialize` result. */
export const SERVER_NAME = 'crmsolid';

/** Human label a client UI shows next to the connection. */
export const SERVER_TITLE = 'CRM Solid';
