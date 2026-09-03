import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';
import { EditorLayout, leaves } from '../layout';

/**
 * CK-5. Reducing the column count merges surplus groups' tabs into the last one
 * and VS Code has no undo for it, so ColumnKit keeps its own ring.
 */

async function readSizes(): Promise<number[]> {
    const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    return leaves(layout.groups).map(n => n.size ?? 0);
}

/**
 * Waits for the grid to lay out. A group written moments ago reports the raw
 * weight it was created with, not a pixel width.
 */
async function settle(): Promise<number[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const sizes = await readSizes();
        if (sizes.every(s => s >= 1)) {
            return sizes;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('editor layout never settled; last read: ' + JSON.stringify(await readSizes()));
}

async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

/**
 * Empties the ring and re-arms the guard, so a test's own recordings are the
 * only ones in it and an earlier undo's suspension window does not carry over.
 */
async function drainHistory(): Promise<ColumnKitApi> {
    const columnKit = await api();
    while (columnKit.history.pop()) {
        // discard
    }
    columnKit.floorGuard.resume();
    return columnKit;
}

suite('layout undo', () => {
    test('restores the column count and the widths a reduction destroyed', async () => {
        const columnKit = await drainHistory();

        await vscode.commands.executeCommand('columnkit.columns3');
        const before = await settle();
        assert.strictEqual(before.length, 3, 'setup should have produced three columns');

        await vscode.commands.executeCommand('columnkit.columns2');
        assert.strictEqual((await settle()).length, 2, 'the reduction should have merged a column');

        await vscode.commands.executeCommand('columnkit.undoLayout');
        const after = await settle();

        assert.strictEqual(after.length, 3, 'undo should have restored the third column');
        assert.deepStrictEqual(after, before, 'undo should have restored the same widths');
        assert.strictEqual(columnKit.history.size, 1, 'undo should consume exactly one entry');
    });

    test('undoes repeatedly, walking back through several changes', async () => {
        const columnKit = await drainHistory();

        await vscode.commands.executeCommand('columnkit.columns4');
        const four = await settle();
        await vscode.commands.executeCommand('columnkit.columns3');
        const three = await settle();
        await vscode.commands.executeCommand('columnkit.columns2');
        await settle();

        await vscode.commands.executeCommand('columnkit.undoLayout');
        assert.deepStrictEqual(await settle(), three, 'first undo should land on the 3-column layout');

        await vscode.commands.executeCommand('columnkit.undoLayout');
        assert.deepStrictEqual(await settle(), four, 'second undo should land on the 4-column layout');

        assert.strictEqual(columnKit.history.size, 1, 'two undos should consume two entries');
    });

    test('does nothing when there is nothing to undo', async () => {
        await drainHistory();
        await vscode.commands.executeCommand('columnkit.columns2');
        const before = await settle();

        // No throw, and no layout change: the ring is empty because drainHistory
        // ran after the write that would have filled it.
        await drainHistory();
        await vscode.commands.executeCommand('columnkit.undoLayout');

        assert.deepStrictEqual(await readSizes(), before, 'an empty ring must not move the layout');
    });

    test('excludes automatic floor corrections from the ring', async () => {
        // Corrections fire on ordinary editor activity. Recording them would bury
        // the user's last deliberate change under a pile of automatic ones.
        const columnKit = await drainHistory();

        // The shape measured to clamp two groups onto the 220 floor.
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 0.5 }, { size: 0.3 }, { size: 0.2 }]
        });
        await settle();

        assert.strictEqual(await columnKit.floorGuard.run(), true, 'guard should have corrected');
        assert.strictEqual(columnKit.history.size, 0, 'a correction must not enter the ring');
    });

    test('holds the floor guard off while a restored layout settles', async () => {
        // An undo restores geometry the user chose, which may legitimately hold a
        // group on the floor. Correcting it would undo the undo.
        //
        // The restored layout MUST contain a floored group or this test is
        // vacuous: the guard returns false on a clean layout whether it is
        // suspended or not. The {0.5, 0.3, 0.2} shape is the one measured to
        // clamp two groups onto the floor.
        const columnKit = await drainHistory();

        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 0.5 }, { size: 0.3 }, { size: 0.2 }]
        });
        const floored = await settle();
        assert.ok(
            floored.some(size => size === 220),
            `setup needs a group on the floor, got ${JSON.stringify(floored)}`
        );

        // Recorded by remember(), so the ring now holds a floored layout.
        await vscode.commands.executeCommand('columnkit.columns2');
        await settle();

        await vscode.commands.executeCommand('columnkit.undoLayout');
        const restored = await settle();

        assert.deepStrictEqual(restored, floored, 'undo should restore the widths verbatim');
        assert.strictEqual(
            await columnKit.floorGuard.run(),
            false,
            'the guard must stand down after an undo, even though the layout is floored'
        );
    });

    test('records the layout before an Even, so Even is undoable too', async () => {
        const columnKit = await drainHistory();
        await vscode.commands.executeCommand('columnkit.even');
        assert.strictEqual(columnKit.history.size, 1, 'Even should have recorded one entry');
    });
});
