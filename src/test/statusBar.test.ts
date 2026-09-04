import * as assert from 'assert';
import * as vscode from 'vscode';
import { buildColumnPickItems } from '../extension';
import { api } from './helpers';

/**
 * CK-7. Status bar text is announced literally, so `$(split-horizontal) Even`
 * reads as "split-horizontal Even" and a preset reads as the bare number "4".
 * There is no API to enumerate status bar items, so the items come out through
 * the activation result.
 */

suite('status bar accessibility', () => {
    test('contributes exactly one item by default', async () => {
        // CK-8. VS Code's status bar guidance is one entry unless more are
        // necessary; the presets live in this one's hover menu instead.
        const items = (await api()).statusBar.contributed;
        assert.strictEqual(items.length, 1, `unexpected item set: ${items.map(i => i.text).join(', ')}`);
        assert.strictEqual(items[0].command, 'columnkit.even', 'clicking the item should even the columns');
    });

    test('the single item carries a hover menu reaching the presets and picker', async () => {
        const tooltip = (await api()).statusBar.contributed[0].tooltip;
        assert.ok(
            tooltip instanceof vscode.MarkdownString,
            'the menu has to be markdown for its command links to render'
        );
        assert.strictEqual(tooltip.isTrusted, true, 'command links are inert without isTrusted');
        for (const command of ['columnkit.columns4', 'columnkit.pickColumns', 'columnkit.undoLayout']) {
            assert.ok(
                tooltip.value.includes(`command:${command}`),
                `hover menu does not reach ${command}`
            );
        }
    });

    test('separate buttons come back when statusBarPresets is set', async () => {
        const cfg = () => vscode.workspace.getConfiguration('columnkit');
        await cfg().update('statusBarPresets', [4, 6, 8], vscode.ConfigurationTarget.Global);
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            const items = (await api()).statusBar.contributed;
            // Even, three presets, and the picker.
            assert.strictEqual(items.length, 5, `got: ${items.map(i => i.text).join(', ')}`);
            assert.deepStrictEqual(
                items.map(i => i.command),
                [
                    'columnkit.even',
                    'columnkit.columns4',
                    'columnkit.columns6',
                    'columnkit.columns8',
                    'columnkit.pickColumns'
                ]
            );
        } finally {
            await cfg().update('statusBarPresets', undefined, vscode.ConfigurationTarget.Global);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    });

    test('ignores preset values outside the supported range', async () => {
        const cfg = () => vscode.workspace.getConfiguration('columnkit');
        await cfg().update('statusBarPresets', [0, 4, 13, 2.5], vscode.ConfigurationTarget.Global);
        try {
            await new Promise(resolve => setTimeout(resolve, 100));
            const commands = (await api()).statusBar.contributed.map(i => i.command);
            assert.deepStrictEqual(commands, [
                'columnkit.even',
                'columnkit.columns4',
                'columnkit.pickColumns'
            ]);
        } finally {
            await cfg().update('statusBarPresets', undefined, vscode.ConfigurationTarget.Global);
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    });

    test('every item carries a name and an accessible label', async () => {
        const items = (await api()).statusBar.contributed;
        assert.ok(items.length > 0, 'no items to check');
        for (const item of items) {
            assert.ok(item.name, `item ${item.text} has no name`);
            assert.ok(
                item.accessibilityInformation?.label,
                `item ${item.text} has no accessibility label`
            );
            assert.strictEqual(item.accessibilityInformation?.role, 'button');
        }
    });

    test('no label leaks codicon markup, which is read aloud verbatim', async () => {
        const items = (await api()).statusBar.contributed;
        assert.ok(items.length > 0, 'no items to check');
        for (const item of items) {
            const label = item.accessibilityInformation!.label;
            assert.ok(
                !/\$\(/.test(label),
                `label "${label}" contains codicon markup, which a screen reader reads as the icon name`
            );
        }
    });

    test('every label stands on its own, since it suppresses the tooltip', async () => {
        const items = (await api()).statusBar.contributed;
        assert.ok(items.length > 0, 'no items to check');
        for (const item of items) {
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
        assert.ok(names.length > 0, 'no items to check');
        assert.strictEqual(new Set(names).size, names.length, `duplicate names: ${names.join(', ')}`);
    });
});

suite('column picker', () => {
    // CK-49. The items are built separately from the quick pick so they can be
    // asserted without a person accepting one.

    test('offers every count from 1 to 12', () => {
        const counts = buildColumnPickItems(3, 12, 0)
            .filter(item => item.columns !== undefined)
            .map(item => item.columns);
        assert.deepStrictEqual(counts, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    test('says which counts will not fit, rather than waiting to be told', () => {
        const items = buildColumnPickItems(3, 3, 0);
        for (const item of items) {
            const fits = (item.columns ?? 0) <= 3;
            assert.strictEqual(
                /will not fit/i.test(item.detail ?? ''),
                !fits,
                `count ${item.columns} said: ${item.detail}`
            );
        }
    });

    test('says nothing about fitting when the width is unknown', () => {
        for (const item of buildColumnPickItems(3, undefined, 0)) {
            assert.doesNotMatch(item.detail ?? '', /will not fit/i);
        }
    });

    test('describes a merge and an addition from where you are', () => {
        const items = buildColumnPickItems(4, 12, 0);
        assert.match(items[1].detail ?? '', /Merges 2 columns/);
        assert.match(items[3].detail ?? '', /Current layout/);
        assert.match(items[4].detail ?? '', /Adds 1 empty column\./);
    });

    test('puts undo last, behind a separator', () => {
        // As the first item it was preselected, so opening the picker and
        // pressing Enter undid a layout change instead of choosing a count.
        const items = buildColumnPickItems(3, 12, 2);
        assert.strictEqual(items[items.length - 1].undo, true);
        assert.strictEqual(
            items[items.length - 2].kind,
            vscode.QuickPickItemKind.Separator,
            'the undo entry should be separated from the counts'
        );
        assert.match(items[items.length - 1].description ?? '', /2 steps/);
        assert.strictEqual(items[0].columns, 1, 'the counts should still lead');
    });

    test('leaves undo out when there is nothing to undo', () => {
        const items = buildColumnPickItems(3, 12, 0);
        assert.strictEqual(items.length, 12);
        assert.ok(!items.some(item => item.undo));
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
                1,
                'the item set should be unchanged after rebuilding'
            );
        } finally {
            await cfg().update('statusBarAlignment', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
