// Bundles the extension for the web worker extension host.
//
// The web host has no module loader, so unlike the desktop build this has to be
// a single file. Everything else is shared: one source tree, two outputs.
//
// node:https and node:crypto stay external. They are reached only from the
// update check, which returns immediately when uiKind is Web, so the bundle
// mentions them and never executes them. Bundling shims for them instead would
// ship a fake crypto implementation nothing calls.

const esbuild = require('esbuild');
const path = require('node:path');

const root = path.join(__dirname, '..');

esbuild
    .build({
        entryPoints: [path.join(root, 'src', 'extension.ts')],
        bundle: true,
        outfile: path.join(root, 'out', 'web', 'extension.js'),
        format: 'cjs',
        platform: 'browser',
        target: 'es2022',
        // The host provides this one; everything else has to be in the bundle.
        external: ['vscode', 'node:https', 'node:crypto'],
        sourcemap: false,
        logLevel: 'info'
    })
    .catch(() => process.exit(1));
