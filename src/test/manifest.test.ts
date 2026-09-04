import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';

/**
 * Manifest contract. These are declarations VS Code reads before any code runs,
 * so nothing else in the suite can catch a regression in them.
 */
suite('manifest', () => {
    const extension = () => {
        const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
        assert.ok(ext, 'ColumnKit should be present in the test host');
        return ext;
    };

    const manifest = () => extension().packageJSON;

    // Commands only exist once the extension has activated, and activation is
    // onStartupFinished, which can land after the first test runs.
    suiteSetup(async () => {
        await extension().activate();
    });

    test('supports untrusted workspaces', () => {
        // Omitting this key means "not supported", which disables the extension
        // in Restricted Mode. ColumnKit reads no workspace content, so being
        // disabled there is a pure loss.
        assert.strictEqual(
            manifest().capabilities?.untrustedWorkspaces?.supported,
            true,
            'ColumnKit must declare untrusted workspace support or it is disabled in Restricted Mode'
        );
    });

    test('declares itself a UI extension, an icon, and virtual workspace support', () => {
        // CK-13. Without extensionKind a Remote SSH, WSL or Codespaces window
        // installs and runs this UI-only extension on the remote host.
        assert.deepStrictEqual(manifest().extensionKind, ['ui']);
        assert.strictEqual(manifest().capabilities?.virtualWorkspaces, true);
        // vsce rejects SVG outright, and anything under 128px square.
        assert.strictEqual(manifest().icon, 'resources/icon.png');
    });

    test('the icon really is a PNG of at least 128 square', () => {
        const icon = path.join(extension().extensionPath, manifest().icon);
        const bytes = fs.readFileSync(icon);
        assert.deepStrictEqual(
            [...bytes.subarray(0, 8)],
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
            'not a PNG'
        );
        assert.strictEqual(bytes.subarray(12, 16).toString('ascii'), 'IHDR');
        assert.ok(bytes.readUInt32BE(16) >= 128, `icon is ${bytes.readUInt32BE(16)}px wide`);
        assert.ok(bytes.readUInt32BE(20) >= 128, `icon is ${bytes.readUInt32BE(20)}px tall`);
    });

    test('opens a log channel and reports what activation cost', async () => {
        // CK-16. The guard mutates the layout from a background handler, and
        // until now a misfire left no record anywhere.
        const columnKit = extension().exports;
        assert.strictEqual(columnKit.log.name, 'ColumnKit');
        assert.ok(typeof columnKit.log.trace === 'function', 'not a LogOutputChannel');
        assert.ok(
            columnKit.activationMs >= 0 && columnKit.activationMs < 5000,
            `implausible activation time: ${columnKit.activationMs}ms`
        );
        // Printed so the README figure comes from a real run.
        console.log(`COLUMNKIT_PROBE activationMs=${columnKit.activationMs}`);
    });

    test('asks the guard to look at the layout it was restored into', async () => {
        // CK-44. VS Code restores the grid and sets the active group before the
        // extension host exists, so no event ever describes the layout we start
        // with. A window reloaded with a column on its floor stayed armed until
        // something unrelated happened. The host cannot be re-activated inside a
        // run, so this asserts the wiring rather than the behaviour.
        assert.strictEqual(extension().exports.scheduledAtActivation, true);
    });

    test('every contributed command is registered at runtime', async () => {
        const contributed: string[] = manifest().contributes.commands.map(
            (c: { command: string }) => c.command
        );
        const registered = await vscode.commands.getCommands(true);
        const missing = contributed.filter(id => !registered.includes(id));
        assert.deepStrictEqual(missing, [], `contributed but never registered: ${missing.join(', ')}`);
    });

    test('every status bar preset resolves to a live command', async () => {
        const registered = await vscode.commands.getCommands(true);
        // statusBarPresets accepts 1..12, and the status bar targets
        // columnkit.columns<n> for each. All twelve must exist.
        const missing: string[] = [];
        for (let n = 1; n <= 12; n++) {
            if (!registered.includes(`columnkit.columns${n}`)) {
                missing.push(`columnkit.columns${n}`);
            }
        }
        assert.deepStrictEqual(missing, [], `preset commands missing: ${missing.join(', ')}`);
    });
});
