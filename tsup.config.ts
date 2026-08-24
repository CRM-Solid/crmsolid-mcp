import { defineConfig } from 'tsup';

// Two builds, because the two artifacts have different jobs.
//
//   index -> a library entry point. Dual ESM + CJS with types, same as
//            @crmsolid/sdk, so the bridge internals can be embedded in a host
//            process (a desktop app, a test harness) rather than spawned.
//   cli   -> the `crmsolid-mcp` binary. ESM only: it is executed by node, never
//            imported, and the leading shebang in src/cli.ts is preserved by
//            esbuild because that file is an entry point.
//
// `clean` is off in both because a second config would otherwise wipe the first
// config's output. The build script clears dist/ once, up front.
export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    outExtension({ format }) {
      return { js: format === 'cjs' ? '.cjs' : '.js' };
    },
    target: 'node20',
    platform: 'node',
    dts: true,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
  },
  {
    entry: { cli: 'src/cli.ts' },
    format: ['esm'],
    target: 'node20',
    platform: 'node',
    dts: false,
    sourcemap: true,
    clean: false,
    splitting: false,
    treeshake: true,
  },
]);
