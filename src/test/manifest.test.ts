import * as assert from 'assert';
import * as vscode from 'vscode';

/**
 * Manifest contract. These are declarations VS Code reads before any code runs,
 * so nothing else in the suite can catch a regression in them.
 */
suite('manifest', () => {
    const extension = () => {
        const ext = vscode.extensions.getExtension('SysAdminDoc.columnkit');
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
