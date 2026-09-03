import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';

/**
 * CK-34. The Claude Code extension locks the editor group it opens in, so the
 * people this extension is built for are working with locked groups all day.
 * Reducing the column count merges surplus groups' tabs into the last one, and
 * nothing had ever checked what that merge does when the target is locked.
 */

async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

const tabCount = () =>
    vscode.window.tabGroups.all.reduce((total, group) => total + group.tabs.length, 0);

/** Puts a distinct document in each of `count` columns. */
async function fillColumns(count: number): Promise<string[]> {
    const titles: string[] = [];
    for (let column = 1; column <= count; column++) {
        const doc = await vscode.workspace.openTextDocument({
            content: `column ${column}`,
            language: 'plaintext'
        });
        await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
        titles.push(doc.uri.toString());
    }
    return titles;
}

suite('locked editor groups', () => {
    teardown(async () => {
        // Locks and open editors both survive into later suites, and a stale
        // lock made the floor guard's own tests fail. Close everything, collapse
        // to one column so no locked group can outlive the suite, then unlock
        // whatever is left. focusEditorGroup takes no argument, so walking the
        // columns has to go through focusNextGroup.
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        for (let i = 0; i < vscode.window.tabGroups.all.length; i++) {
            await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
            await vscode.commands.executeCommand('workbench.action.focusNextGroup');
        }
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 1 }]
        });
        await vscode.commands.executeCommand('workbench.action.unlockEditorGroup');
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    test('a reduction onto a locked group keeps every tab and reports the truth', async function () {
        this.timeout(30000);
        const columnKit = await api();

        await vscode.commands.executeCommand('columnkit.columns3');
        const opened = await fillColumns(3);
        assert.strictEqual(tabCount(), opened.length, 'setup should have opened one tab per column');

        // lockEditorGroup acts on the active group, so the last one has to be
        // focused before it is locked. That is the group applyLayout merges into.
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');
        const locked = vscode.window.tabGroups.all.find(g => g.viewColumn === 3);
        assert.ok(locked, 'expected a third group to lock');

        const before = tabCount();
        await vscode.commands.executeCommand('columnkit.columns2');
        await new Promise(resolve => setTimeout(resolve, 200));

        // Whatever the editor decided, nothing may be lost.
        assert.strictEqual(tabCount(), before, 'a column change must never drop a tab');

        // And the message must describe what actually happened. setColumns reads
        // the layout back, so the count it reports is measured, not requested.
        const last = columnKit.lastNotification();
        assert.ok(last, 'the change was not reported at all');
        const actual = vscode.window.tabGroups.all.length;
        // Recorded so the answer to "does the merge honour the lock" is in the run.
        console.log(`COLUMNKIT_PROBE lockedMerge columns=${actual} tabs=${tabCount()} message=${last.message}`);
        assert.ok(
            last.message.includes(`${actual} column`),
            `message "${last.message}" does not match the ${actual} columns that exist`
        );
    });

    test('a locked group does not stop the guard raising it off the floor', async function () {
        this.timeout(30000);
        const columnKit = await api();

        await vscode.commands.executeCommand('columnkit.columns3');
        await fillColumns(3);
        await vscode.commands.executeCommand('workbench.action.focusThirdEditorGroup');
        await vscode.commands.executeCommand('workbench.action.lockEditorGroup');

        const layout = await vscode.commands.executeCommand<{
            orientation: number;
            groups: { size?: number }[];
        }>('vscode.getEditorLayout');
        const width = layout.groups.reduce((a, g) => a + (g.size ?? 0), 0);
        const wide = width - 220 * 2;
        assert.ok(wide >= 220, `editor area ${width} too narrow for this setup`);

        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: wide }, { size: 220 }, { size: 220 }]
        });
        await new Promise(resolve => setTimeout(resolve, 100));

        columnKit.floorGuard.resume();
        assert.strictEqual(
            await columnKit.floorGuard.run(),
            true,
            'the guard must still be able to resize a locked group'
        );

        const after = await vscode.commands.executeCommand<{ groups: { size?: number }[] }>(
            'vscode.getEditorLayout'
        );
        for (const group of after.groups) {
            assert.ok(
                (group.size ?? 0) > 220,
                `group left at ${group.size}; locking must not defeat the guard`
            );
        }
    });
});
