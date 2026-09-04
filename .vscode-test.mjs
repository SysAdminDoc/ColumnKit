import { defineConfig } from '@vscode/test-cli';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));

// These MUST be absolute. A relative --user-data-dir resolves against the VS Code
// installation directory, not this repo, which lands in Program Files and fails
// every write with access denied.
const userDataDir = path.join(root, '.vscode-test', 'user-data');
const extensionsDir = path.join(root, '.vscode-test', 'extensions');

// The update check runs at activation, which is before any test can turn it
// off, so a plain run used to hit api.github.com every time. That is a flake
// source when offline and a live request from a test run. Seeded here because
// the host reads this file on startup.
const settingsDir = path.join(userDataDir, 'User');
fs.mkdirSync(settingsDir, { recursive: true });
fs.writeFileSync(
    path.join(settingsDir, 'settings.json'),
    JSON.stringify({ 'columnkit.checkForUpdates': false }, null, 4)
);

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
