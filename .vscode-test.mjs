import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

// These MUST be absolute. A relative --user-data-dir resolves against the VS Code
// installation directory, not this repo, which lands in Program Files and fails
// every write with access denied.
const userDataDir = path.join(root, '.vscode-test', 'user-data');
const extensionsDir = path.join(root, '.vscode-test', 'extensions');

export default defineConfig({
    files: 'out/test/**/*.test.js',
    version: 'stable',
    launchArgs: [
        '--disable-extensions',
        '--disable-gpu',
        `--user-data-dir=${userDataDir}`,
        `--extensions-dir=${extensionsDir}`
    ]
});
