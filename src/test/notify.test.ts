import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';

/**
 * CK-31. VS Code renders the status bar `role="status"` with `aria-live="off"`,
 * so nothing said there reaches a screen reader. Notifications are pushed
 * through an ARIA alert, so in screen reader mode the outcome has to go there
 * instead.
 */

async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

const editor = () => vscode.workspace.getConfiguration('editor');

async function setAccessibilitySupport(value: string | undefined): Promise<void> {
    await editor().update('accessibilitySupport', value, vscode.ConfigurationTarget.Global);
    await new Promise(resolve => setTimeout(resolve, 50));
}

suite('notify', () => {
    teardown(async () => {
        await setAccessibilitySupport(undefined);
    });

    test('uses the status bar when the editor is not in screen reader mode', async () => {
        await setAccessibilitySupport('off');
        const columnKit = await api();

        await vscode.commands.executeCommand('columnkit.columns2');

        const last = columnKit.lastNotification();
        assert.ok(last, 'nothing was reported at all');
        assert.strictEqual(last.channel, 'statusBar');
        assert.match(last.message, /^ColumnKit: /);
    });

    test('uses a notification when screen reader mode is on', async () => {
        await setAccessibilitySupport('on');
        const columnKit = await api();

        await vscode.commands.executeCommand('columnkit.columns3');

        const last = columnKit.lastNotification();
        assert.ok(last, 'nothing was reported at all');
        assert.strictEqual(
            last.channel,
            'notification',
            'the status bar is never announced, so this outcome would be silent'
        );
    });

    test('routes the undo outcome the same way', async () => {
        await setAccessibilitySupport('on');
        const columnKit = await api();

        await vscode.commands.executeCommand('columnkit.undoLayout');

        const last = columnKit.lastNotification();
        assert.ok(last);
        assert.strictEqual(last.channel, 'notification');
    });

    test('reports nothing-to-undo rather than staying silent', async () => {
        await setAccessibilitySupport('off');
        const columnKit = await api();
        while (columnKit.history.pop()) {
            // empty the ring
        }

        await vscode.commands.executeCommand('columnkit.undoLayout');

        assert.match(columnKit.lastNotification()!.message, /nothing to undo/);
    });
});
