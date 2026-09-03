import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';

/**
 * CK-7. Status bar text is announced literally, so `$(split-horizontal) Even`
 * reads as "split-horizontal Even" and a preset reads as the bare number "4".
 * There is no API to enumerate status bar items, so the items come out through
 * the activation result.
 */

async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

suite('status bar accessibility', () => {
    test('contributes the default set of items', async () => {
        const items = (await api()).statusBar.contributed;
        // Even, the three default presets, and the picker.
        assert.strictEqual(items.length, 5, `unexpected item set: ${items.map(i => i.text).join(', ')}`);
    });

    test('every item carries a name and an accessible label', async () => {
        for (const item of (await api()).statusBar.contributed) {
            assert.ok(item.name, `item ${item.text} has no name`);
            assert.ok(
                item.accessibilityInformation?.label,
                `item ${item.text} has no accessibility label`
            );
            assert.strictEqual(item.accessibilityInformation?.role, 'button');
        }
    });

    test('no label leaks codicon markup, which is read aloud verbatim', async () => {
        for (const item of (await api()).statusBar.contributed) {
            const label = item.accessibilityInformation!.label;
            assert.ok(
                !/\$\(/.test(label),
                `label "${label}" contains codicon markup, which a screen reader reads as the icon name`
            );
        }
    });

    test('every label stands on its own, since it suppresses the tooltip', async () => {
        for (const item of (await api()).statusBar.contributed) {
            const label = item.accessibilityInformation!.label;
            // A bare number or icon name says nothing about what activating it
            // does. Requiring more than one word is a cheap proxy for that.
            assert.ok(
                label.trim().split(/\s+/).length >= 2,
                `label "${label}" for item "${item.text}" is not self-sufficient`
            );
            assert.ok(/column/i.test(label), `label "${label}" never says what it acts on`);
        }
    });

    test('names are distinct, so a hidden item can be found again', async () => {
        const names = (await api()).statusBar.contributed.map(i => i.name);
        assert.strictEqual(new Set(names).size, names.length, `duplicate names: ${names.join(', ')}`);
    });
});

suite('status bar lifetime', () => {
    test('rebuilding on a setting change does not grow the subscription list', async function () {
        // CK-11. Every rebuild used to push its fresh items into the extension's
        // subscriptions without removing the previous ones.
        this.timeout(60000);
        const columnKit = await api();
        const cfg = () => vscode.workspace.getConfiguration('columnkit');

        // One rebuild first, so the count is measured after any lazy setup.
        await cfg().update('statusBarAlignment', 'right', vscode.ConfigurationTarget.Global);
        await new Promise(resolve => setTimeout(resolve, 50));
        const before = columnKit.subscriptionCount();

        try {
            for (let i = 0; i < 50; i++) {
                await cfg().update(
                    'statusBarAlignment',
                    i % 2 === 0 ? 'left' : 'right',
                    vscode.ConfigurationTarget.Global
                );
            }
            await new Promise(resolve => setTimeout(resolve, 100));

            assert.strictEqual(
                columnKit.subscriptionCount(),
                before,
                'subscriptions grew across 50 rebuilds'
            );
            assert.strictEqual(
                columnKit.statusBar.contributed.length,
                5,
                'the item set should be unchanged after rebuilding'
            );
        } finally {
            await cfg().update('statusBarAlignment', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
