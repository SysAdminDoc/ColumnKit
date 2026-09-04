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

const FLOOR = 220;

/**
 * Parks two groups exactly on the floor, at whatever width the test host
 * happens to be. See the twin in floorGuard.test.ts for why this asks for the
 * floor outright instead of relying on VS Code to clamp a smaller request up.
 */
async function parkOnFloor(): Promise<number[]> {
    const width = (await settle()).reduce((a, b) => a + b, 0);
    const wide = width - FLOOR * 2;
    assert.ok(wide >= FLOOR, `editor area ${width} is too narrow for this setup`);
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: wide }, { size: FLOOR }, { size: FLOOR }]
    });
    const sizes = await settle();
    // See the twin in floorGuard.test.ts: cancel the correction this write
    // schedules, or it lands between the setup and the assertion.
    (await api()).floorGuard.resume();
    return sizes;
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

/** Column each open document sits in, keyed by its resource. */
function placement(): Map<string, number> {
    const columns = new Map<string, number>();
    for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
            const input = tab.input as { uri?: vscode.Uri } | undefined;
            if (input?.uri) {
                columns.set(input.uri.toString(), group.viewColumn);
            }
        }
    }
    return columns;
}

/** Puts one distinct document in each of `count` columns, in order. */
async function fillColumns(count: number): Promise<string[]> {
    const opened: string[] = [];
    for (let column = 1; column <= count; column++) {
        const doc = await vscode.workspace.openTextDocument({
            content: `undo probe column ${column}`,
            language: 'plaintext'
        });
        await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
        opened.push(doc.uri.toString());
    }
    return opened;
}

suite('layout undo', () => {
    // Open editors survive into later suites and would then be dragged around
    // by another test's undo, so every test here leaves the tabs empty.
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    test('puts merged tabs back in the columns they came from', async function () {
        // CK-37. Restoring geometry alone recreates the empty columns and
        // leaves every merged tab piled in the group applyLayout moved it to,
        // which is the arrangement README says undo gives back.
        this.timeout(30000);
        const columnKit = await drainHistory();

        await vscode.commands.executeCommand('columnkit.columns3');
        await settle();
        const opened = await fillColumns(3);
        const before = placement();
        assert.deepStrictEqual(
            opened.map(uri => before.get(uri)),
            [1, 2, 3],
            `setup should have put one document in each column, got ${JSON.stringify([...before])}`
        );
        const widths = await settle();

        await vscode.commands.executeCommand('columnkit.columns2');
        await settle();
        // Without this the test would pass on a build that never moved a tab.
        assert.notDeepStrictEqual(
            opened.map(uri => placement().get(uri)),
            [1, 2, 3],
            'the reduction should have merged a column'
        );

        await vscode.commands.executeCommand('columnkit.undoLayout');
        await settle();

        const after = placement();
        assert.deepStrictEqual(
            opened.map(uri => after.get(uri)),
            [1, 2, 3],
            `undo left the tabs at ${JSON.stringify([...after])}`
        );
        assert.deepStrictEqual(await settle(), widths, 'undo should restore the widths too');
        assert.strictEqual(
            columnKit.lastNotification()?.message,
            'ColumnKit: layout restored.',
            'nothing should have been reported as stranded'
        );
    });

    test('leaves tabs alone when the change added columns rather than merging', async function () {
        // Only a reduction moves tabs, so only a reduction records where they
        // were. Recording on every change would drag a hand-moved tab back.
        this.timeout(30000);
        const columnKit = await drainHistory();

        await vscode.commands.executeCommand('columnkit.columns2');
        await settle();
        await fillColumns(2);

        await vscode.commands.executeCommand('columnkit.columns3');
        await settle();
        assert.strictEqual(columnKit.history.size, 2, 'both changes should be on the ring');

        const entry = columnKit.history.pop();
        assert.ok(entry, 'the widening should have recorded an entry');
        assert.strictEqual(entry.tabs, undefined, 'a widening must not record tab placement');
    });

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
        const columnKit = await drainHistory();
        assert.strictEqual(columnKit.history.size, 0, 'setup must leave the ring empty');
        await vscode.commands.executeCommand('columnkit.undoLayout');

        assert.deepStrictEqual(await settle(), before, 'an empty ring must not move the layout');
    });

    test('excludes automatic floor corrections from the ring', async () => {
        // Corrections fire on ordinary editor activity. Recording them would bury
        // the user's last deliberate change under a pile of automatic ones.
        const columnKit = await drainHistory();
        await parkOnFloor();

        assert.strictEqual(await columnKit.floorGuard.run(), true, 'guard should have corrected');
        assert.strictEqual(columnKit.history.size, 0, 'a correction must not enter the ring');
    });

    test('holds the floor guard off while a restored layout settles', async () => {
        // An undo restores geometry the user chose, which may legitimately hold a
        // group on the floor. Correcting it would undo the undo.
        //
        // The restored layout MUST contain a floored group or this test is
        // vacuous: the guard returns false on a clean layout whether it is
        // suspended or not.
        const columnKit = await drainHistory();

        const floored = await parkOnFloor();
        assert.ok(
            floored.filter(size => size === FLOOR).length >= 2,
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

    test('records the layout before an Even, and skips one that changes nothing', async function () {
        // CK-43 changed this deliberately: Even now records only when the widths
        // actually moved. The old test ran Even on an already-even layout and
        // asserted an entry, which is the step that undid to identical widths
        // while announcing a restore. So the setup makes the layout uneven.
        this.timeout(30000);
        const columnKit = await drainHistory();

        const width = (await settle()).reduce((a, b) => a + b, 0);
        assert.ok(width - 500 >= FLOOR, `editor area ${width} is too narrow for this setup`);
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: width - 500 }, { size: 250 }, { size: 250 }]
        });
        const uneven = await settle();
        columnKit.floorGuard.resume();
        await drainHistory();

        await vscode.commands.executeCommand('columnkit.even');
        await settle();
        assert.strictEqual(
            columnKit.history.size,
            1,
            'Even should have recorded the uneven layout it replaced'
        );
        assert.notDeepStrictEqual(await settle(), uneven, 'Even did not actually change anything');

        await vscode.commands.executeCommand('columnkit.even');
        await settle();
        assert.strictEqual(
            columnKit.history.size,
            1,
            'a second Even moved nothing and must not push a step that undoes to the same widths'
        );
    });
});
