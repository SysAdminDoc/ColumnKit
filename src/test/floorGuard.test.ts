import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';
import { CORRECTION_MARGIN, EditorLayout, leaves } from '../layout';

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
    // These exact weights are the shape measured on 2026-09-03 to produce
    // [412, 220, 220]: two groups clamped onto the floor. Small or lopsided
    // weights are NOT reliable here. A share of 0.1 or 0.01 leaves the group at
    // a sub-pixel size that never gets clamped up to the minimum, so the layout
    // reads back as 0.1px and no group is on the floor at all.
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.5 }, { size: 0.3 }, { size: 0.2 }]
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
    test('a below-minimum request really does land on the floor', async () => {
        const sizes = await parkOnFloor();
        assert.ok(
            flooredIndexes(sizes).length >= 1,
            `expected at least one group clamped to exactly ${FLOOR}, got ${JSON.stringify(sizes)}`
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
