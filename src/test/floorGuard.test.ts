import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';
import { CORRECTION_MARGIN, EditorLayout, SETTINGS_FLOOR, leaves } from '../layout';

const FLOOR = 220;

async function readSizes(): Promise<number[]> {
    const layout = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    return leaves(layout.groups).map(n => n.size ?? 0);
}

/**
 * Produces groups parked exactly on the floor. Requesting a share narrower than
 * the minimum makes VS Code clamp it to precisely `minimumWidth`, which is the
 * strict-equality value doRestoreGroup expands on.
 */
async function parkOnFloor(): Promise<number[]> {
    // Asks for the floor exactly, rather than asking for less and relying on
    // VS Code to clamp upward.
    //
    // Clamping is not dependable. The old {0.5, 0.3, 0.2} shape worked only
    // because the test host happened to be about 852px wide, and a pixel
    // request of [540, 170, 170] against an 880px area was honoured verbatim,
    // leaving nothing on the floor at all. Requesting FLOOR needs no clamp and
    // holds at any window width.
    const width = (await settle()).reduce((a, b) => a + b, 0);
    const wide = width - FLOOR * 2;
    assert.ok(
        wide >= FLOOR,
        `editor area ${width} is too narrow to hold three groups above the floor`
    );
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: wide }, { size: FLOOR }, { size: FLOOR }]
    });
    return settle();
}

/** Indexes of every group sitting exactly on the floor. */
function flooredIndexes(sizes: number[]): number[] {
    return sizes.map((size, i) => (size === FLOOR ? i : -1)).filter(i => i >= 0);
}

/**
 * Waits for the grid to lay out. A group created moments ago reports the raw
 * weight it was written with, not a pixel width, so reading immediately after a
 * write yields values like 0.01.
 */
async function settle(): Promise<number[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const sizes = await readSizes();
        if (sizes.every(s => s >= 1)) {
            return sizes;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('editor layout never settled into pixel values; last read: ' + JSON.stringify(await readSizes()));
}

async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

suite('FloorGuard', () => {
    // An undo suspends corrections globally for a few hundred milliseconds, and
    // the undo suite can run inside that window. Clear it so each test here
    // starts from an armed guard rather than inheriting another suite's state.
    setup(async () => {
        (await api()).floorGuard.resume();
    });

    // Settings and Keyboard Shortcuts stay open otherwise, and the next test's
    // floors would be read from whichever of them is still active.
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await new Promise(resolve => setTimeout(resolve, 100));
    });

    test('a layout really can hold groups sitting exactly on the floor', async () => {
        // The state the whole extension exists to defuse: a group whose width
        // equals its minimum, which doRestoreGroup expands on every click.
        //
        // This used to request a below-minimum share and assert VS Code clamped
        // it up. That clamp turned out to be unreliable, so the setup now asks
        // for the floor outright and this asserts the state was reached.
        const sizes = await parkOnFloor();
        assert.ok(
            flooredIndexes(sizes).length >= 2,
            `expected two groups at exactly ${FLOOR}, got ${JSON.stringify(sizes)}`
        );
    });

    test('raises every floored group clear of the trigger', async () => {
        // More than one group on the floor. Correcting only the active one would
        // leave the others armed, and VS Code expands them before the extension
        // host is ever told the active group changed.
        const before = await parkOnFloor();
        const floored = flooredIndexes(before);
        assert.ok(floored.length >= 2, `expected 2+ floored groups, got ${JSON.stringify(before)}`);

        const columnKit = await api();
        assert.strictEqual(await columnKit.floorGuard.run(), true, 'guard should have corrected');

        const after = await readSizes();
        for (const i of floored) {
            assert.strictEqual(after[i], FLOOR + CORRECTION_MARGIN, `group ${i} not raised`);
        }
        for (const size of after) {
            assert.ok(size > FLOOR, `group left at ${size}; the expand trigger is still armed`);
        }
    });

    test('preserves the total editor width', async () => {
        const before = await parkOnFloor();
        const columnKit = await api();
        await columnKit.floorGuard.run();
        const after = await readSizes();
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        assert.strictEqual(sum(after), sum(before), 'correction rescaled the editor area');
    });

    test('is idempotent, so a corrected layout is left alone', async () => {
        await parkOnFloor();
        const columnKit = await api();

        assert.strictEqual(await columnKit.floorGuard.run(), true, 'first run corrects');
        const afterFirst = await readSizes();
        assert.strictEqual(await columnKit.floorGuard.run(), false, 'second run is a no-op');
        assert.deepStrictEqual(await readSizes(), afterFirst, 'a no-op must not move anything');
    });

    test('collapses concurrent runs into a single write', async () => {
        await parkOnFloor();
        const columnKit = await api();

        const before = columnKit.floorGuard.corrections;
        await Promise.all([
            columnKit.floorGuard.run(),
            columnKit.floorGuard.run(),
            columnKit.floorGuard.run()
        ]);
        const written = columnKit.floorGuard.corrections - before;
        assert.strictEqual(written, 1, `expected exactly one write, got ${written}`);
    });

    test('does nothing when only one group is open', async () => {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 1 }]
        });
        const columnKit = await api();
        assert.strictEqual(await columnKit.floorGuard.run(), false);
    });

    test('leaves a nested grid alone rather than flattening it', async () => {
        // Sizes under a perpendicular branch are heights, not widths. Correcting
        // them against a width floor and writing back flat would destroy the grid.
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 0.01 }, { groups: [{ size: 1 }, { size: 1 }] }]
        });
        const before = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
        const columnKit = await api();

        assert.strictEqual(await columnKit.floorGuard.run(), false, 'must refuse a nested layout');

        const after = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
        assert.strictEqual(
            after.groups.length,
            before.groups.length,
            'nested grid was flattened'
        );
        assert.ok(
            after.groups.some(g => g.groups && g.groups.length > 0),
            'nesting was lost'
        );
    });

    // CK-39. Both of these open a pane VS Code's tab model cannot classify, so
    // `tab.input` is undefined for each. Only one of them is really floored.
    async function narrowSecondColumn(): Promise<number> {
        const width = (await settle()).reduce((a, b) => a + b, 0);
        assert.ok(width - 300 >= FLOOR, `editor area ${width} is too narrow for this setup`);
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: width - 300 }, { size: 300 }]
        });
        await settle();
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        // Let the correction the focus change schedules run to completion, so
        // what happens next is attributable to the pane and nothing else.
        await new Promise(resolve => setTimeout(resolve, 600));
        return width;
    }

    test('leaves Keyboard Shortcuts alone, which is not clamped to 500', async function () {
        // It reports `input === undefined` exactly like Settings does. Assuming
        // that means a 500px floor yanked this column from 300 out to 524.
        this.timeout(30000);
        await narrowSecondColumn();
        const columnKit = await api();

        await vscode.commands.executeCommand('workbench.action.openGlobalKeybindings');
        await new Promise(resolve => setTimeout(resolve, 400));
        const opened = await settle();
        assert.strictEqual(
            opened[1],
            300,
            `VS Code moved the column on its own, so this test proves nothing: ${JSON.stringify(opened)}`
        );

        columnKit.floorGuard.resume();
        assert.strictEqual(
            await columnKit.floorGuard.run(),
            false,
            'a pane sitting at 300 is on no floor and must not be moved'
        );
        assert.deepStrictEqual(await settle(), opened, 'the guard resized a column that was not armed');
    });

    test('still raises Settings, which really is clamped to 500', async function () {
        // Positive control for the test above. Without it, a guard that had
        // simply stopped working would look identical.
        this.timeout(30000);
        await narrowSecondColumn();
        const columnKit = await api();

        await vscode.commands.executeCommand('workbench.action.openSettings');
        await new Promise(resolve => setTimeout(resolve, 400));
        const opened = await settle();
        assert.strictEqual(
            opened[1],
            SETTINGS_FLOOR,
            `Settings should have been clamped to its own minimum, got ${JSON.stringify(opened)}`
        );

        columnKit.floorGuard.resume();
        assert.strictEqual(
            await columnKit.floorGuard.run(),
            true,
            'a Settings pane on exactly 500 is armed and must be raised'
        );
        assert.strictEqual((await settle())[1], SETTINGS_FLOOR + CORRECTION_MARGIN);
    });

    test('respects the autoCorrect setting', async () => {
        const cfg = vscode.workspace.getConfiguration('columnkit');
        await cfg.update('autoCorrect', false, vscode.ConfigurationTarget.Global);
        try {
            const before = await parkOnFloor();
            const columnKit = await api();
            assert.strictEqual(await columnKit.floorGuard.run(), false, 'disabled guard must not write');
            assert.deepStrictEqual(
                await readSizes(),
                before,
                'layout should be untouched when disabled'
            );
        } finally {
            await cfg.update('autoCorrect', undefined, vscode.ConfigurationTarget.Global);
        }
    });
});
