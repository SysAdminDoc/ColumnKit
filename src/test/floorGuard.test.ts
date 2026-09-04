import * as assert from 'assert';
import * as vscode from 'vscode';
import { CORRECTION_MARGIN, EditorLayout, SETTINGS_FLOOR } from '../layout';
import { FLOOR, api, flooredIndexes, parkOnFloor, quietly, readSizes, settle } from './helpers';

suite('FloorGuard', () => {
    // An undo suspends corrections globally for a few hundred milliseconds, and
    // the undo suite can run inside that window. Clear it so each test here
    // starts from an armed guard rather than inheriting another suite's state.
    setup(async () => {
        (await api()).floorGuard.resume();
    });

    // Settings and Keyboard Shortcuts stay open otherwise, and the next test's
    // floors would be read from whichever of them is still active. The layout
    // is reset too: a test that leaves a stack of rows behind makes the next
    // one's `settle()` read heights and compute a nonsense width from them.
    teardown(async () => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors');
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 1 }]
        });
        await new Promise(resolve => setTimeout(resolve, 150));
        (await api()).floorGuard.resume();
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

    test('corrects a floored column of a 2D grid without flattening it', async function () {
        // CK-21 changed this deliberately. The guard used to refuse any nested
        // layout, because a flat write would have destroyed the grid, which
        // left a floored column armed on every 2D layout. With orientation 0 a
        // top-level node is a column and its size is a width whatever it holds,
        // so the correction works on those and carries the children through.
        this.timeout(30000);
        const columnKit = await api();
        const { width, before } = await quietly(async () => {
            const measured = (await settle()).reduce((a, b) => a + b, 0);
            assert.ok(measured - FLOOR >= FLOOR, `editor area ${measured} too narrow for this setup`);

            // One ordinary column beside a column split into two rows, the
            // split one parked exactly on the floor.
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [
                    { size: measured - FLOOR },
                    { size: FLOOR, groups: [{ size: 1 }, { size: 1 }] }
                ]
            });
            await settle();
            return {
                width: measured,
                before: await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout')
            };
        });
        assert.ok(
            before.groups.some(g => g.groups && g.groups.length > 0),
            'setup did not produce a nested grid'
        );
        assert.strictEqual(
            before.groups[1].size,
            FLOOR,
            `setup did not reach the floor: ${JSON.stringify(before)}`
        );

        columnKit.floorGuard.resume();
        assert.strictEqual(await columnKit.floorGuard.run(), true, 'the floored column was not corrected');

        const after = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
        assert.strictEqual(after.groups.length, before.groups.length, 'nested grid was flattened');
        assert.ok(
            after.groups.some(g => g.groups && g.groups.length > 0),
            'nesting was lost'
        );
        assert.strictEqual(after.groups[1].size, FLOOR + CORRECTION_MARGIN);
        assert.strictEqual(
            after.groups.reduce((total, g) => total + (g.size ?? 0), 0),
            width,
            'the correction rescaled the editor area'
        );
    });

    test('leaves a stack of rows alone, whose sizes are heights', async () => {
        // Orientation 1 means the top-level sizes are heights, and the trigger
        // for those is minimumHeight, not the 220 width floor. Correcting them
        // against a width would silently undo the user's drag.
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 1,
            groups: [{ size: 70 }, { size: 400 }]
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        const before = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
        const columnKit = await api();
        columnKit.floorGuard.resume();

        assert.strictEqual(await columnKit.floorGuard.run(), false, 'rows are not columns');

        const after = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
        assert.deepStrictEqual(
            after.groups.map(g => g.size),
            before.groups.map(g => g.size),
            'a stack of rows was resized against a width floor'
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
        const columnKit = await api();
        const cfg = vscode.workspace.getConfiguration('columnkit');

        // The guard now wakes on a tab change too, so with it armed it corrects
        // the clamp before this can observe it. Off for the setup, on for the
        // assertion.
        await cfg.update('autoCorrect', false, vscode.ConfigurationTarget.Global);
        let opened: number[];
        try {
            await narrowSecondColumn();
            await vscode.commands.executeCommand('workbench.action.openSettings');
            await new Promise(resolve => setTimeout(resolve, 400));
            opened = await settle();
            assert.strictEqual(
                opened[1],
                SETTINGS_FLOOR,
                `Settings should have been clamped to its own minimum, got ${JSON.stringify(opened)}`
            );
        } finally {
            await cfg.update('autoCorrect', undefined, vscode.ConfigurationTarget.Global);
        }

        columnKit.floorGuard.resume();
        assert.strictEqual(
            await columnKit.floorGuard.run(),
            true,
            'a Settings pane on exactly 500 is armed and must be raised'
        );
        assert.strictEqual((await settle())[1], SETTINGS_FLOOR + CORRECTION_MARGIN);
    });

    test('wakes on a tab change, not just a group change', async function () {
        // CK-47. Opening Settings in a narrow column fires onDidChangeTabs and
        // nothing else, while VS Code clamps the column to exactly 500, which is
        // the arming width. Listening to group changes alone left it armed.
        this.timeout(30000);
        await narrowSecondColumn();
        const columnKit = await api();
        columnKit.floorGuard.resume();
        const before = columnKit.floorGuard.corrections;

        await vscode.commands.executeCommand('workbench.action.openSettings');
        // Long enough for the debounce plus the write, with nothing else
        // touching the group set in between.
        await new Promise(resolve => setTimeout(resolve, 1500));

        assert.ok(
            columnKit.floorGuard.corrections > before,
            'a tab-only change left the column armed'
        );
        assert.strictEqual((await settle())[1], SETTINGS_FLOOR + CORRECTION_MARGIN);
    });

    test('evens one column of a grid and leaves the other exactly as it was', async function () {
        // CK-20. evenEditorWidths distributes the whole grid, so there was no
        // way to tidy one column's rows without disturbing its neighbour.
        this.timeout(30000);
        const columnKit = await api();
        const before = await quietly(async () => {
            const width = (await settle()).reduce((a, b) => a + b, 0);
            const half = Math.floor(width / 2);
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [
                    { size: half, groups: [{ size: 100 }, { size: 300 }] },
                    { size: width - half, groups: [{ size: 120 }, { size: 280 }] }
                ]
            });
            await settle();
            return vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
        });
        assert.strictEqual(before.groups.length, 2, 'setup did not produce two columns');
        assert.strictEqual(before.groups[0].groups?.length, 2, 'setup did not split them');

        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        await new Promise(resolve => setTimeout(resolve, 200));
        columnKit.floorGuard.resume();

        await vscode.commands.executeCommand('columnkit.evenSplit');
        await new Promise(resolve => setTimeout(resolve, 400));
        const after = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');

        const rows = (layout: EditorLayout, column: number) =>
            layout.groups[column].groups?.map(node => node.size);
        const evened = rows(after, 0)!;
        assert.strictEqual(evened.length, 2);
        assert.ok(
            Math.abs((evened[0] ?? 0) - (evened[1] ?? 0)) <= 1,
            `the active column's rows were not evened: ${JSON.stringify(evened)}`
        );
        assert.deepStrictEqual(
            rows(after, 1),
            rows(before, 1),
            'the other column was disturbed'
        );
        assert.deepStrictEqual(
            after.groups.map(node => node.size),
            before.groups.map(node => node.size),
            'the column widths moved'
        );
    });

    test('gives the active column the share it was asked for', async function () {
        // CK-19. A count is not always what someone means; "half the width" is.
        this.timeout(30000);
        await vscode.commands.executeCommand('columnkit.columns3');
        await settle();
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await new Promise(resolve => setTimeout(resolve, 300));
        (await api()).floorGuard.resume();

        await vscode.commands.executeCommand('columnkit.setColumnWidth', 40);
        const sizes = await settle();
        const total = sizes.reduce((a, b) => a + b, 0);

        assert.strictEqual(sizes.length, 3);
        assert.ok(
            Math.abs(sizes[1] / total - 0.4) < 0.02,
            `column 2 got ${Math.round((sizes[1] / total) * 100)}%, not 40: ${JSON.stringify(sizes)}`
        );
        // The default strategy is even, so the other two match to a pixel.
        assert.ok(
            Math.abs(sizes[0] - sizes[2]) <= 1,
            `the remainder was not shared evenly: ${JSON.stringify(sizes)}`
        );
        for (const size of sizes) {
            assert.ok(size > FLOOR, `group left at ${size}`);
        }
    });

    test('refuses a share that would put another column on the floor', async function () {
        this.timeout(30000);
        const columnKit = await api();
        await vscode.commands.executeCommand('columnkit.columns3');
        await settle();
        await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
        await new Promise(resolve => setTimeout(resolve, 300));
        columnKit.floorGuard.resume();
        const before = await settle();

        await vscode.commands.executeCommand('columnkit.setColumnWidth', 90);

        assert.deepStrictEqual(await settle(), before, 'the layout should not have moved');
        assert.match(columnKit.lastNotification()?.message ?? '', /minimum width/);
    });

    test('does not watch on a timer unless asked to', async () => {
        // CK-30. Polling is the only signal for a sash drag, and it is the one
        // thing in here that costs something when nothing is happening.
        const columnKit = await api();
        assert.strictEqual(columnKit.floorGuard.polling, false);
    });

    test('catches a column that reaches the floor with no event at all', async function () {
        // A same-count setEditorLayout fires neither a tab nor a group event,
        // measured on 1.136.1, which is the same silence a sash drag produces.
        // So this parks a column on the floor in a way the event path cannot
        // see, and only the idle watch can rescue it.
        this.timeout(30000);
        const columnKit = await api();
        const cfg = vscode.workspace.getConfiguration('columnkit');

        // Three groups first, so the write below does not change the count.
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 1 }, { size: 1 }, { size: 1 }]
        });
        const settled = await settle();
        const width = settled.reduce((a, b) => a + b, 0);
        columnKit.floorGuard.resume();

        await cfg.update('watchWhileIdle', true, vscode.ConfigurationTarget.Global);
        try {
            await new Promise(resolve => setTimeout(resolve, 200));
            assert.strictEqual(columnKit.floorGuard.polling, true, 'the watch did not start');

            const before = columnKit.floorGuard.corrections;
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [{ size: width - FLOOR * 2 }, { size: FLOOR }, { size: FLOOR }]
            });
            const floored = await settle();
            assert.ok(
                flooredIndexes(floored).length >= 2,
                `setup did not reach the floor: ${JSON.stringify(floored)}`
            );

            // Nothing else is touched from here: no command, no tab, no group.
            for (let waited = 0; waited < 8000; waited += 250) {
                if (columnKit.floorGuard.corrections > before) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            assert.ok(
                columnKit.floorGuard.corrections > before,
                'the idle watch never noticed a column sitting on the floor'
            );
            for (const size of await settle()) {
                assert.ok(size > FLOOR, `group left at ${size}`);
            }
        } finally {
            await cfg.update('watchWhileIdle', undefined, vscode.ConfigurationTarget.Global);
            await new Promise(resolve => setTimeout(resolve, 200));
        }
    });

    test('stops watching when the setting goes back off', async function () {
        this.timeout(30000);
        const columnKit = await api();
        const cfg = vscode.workspace.getConfiguration('columnkit');
        await cfg.update('watchWhileIdle', true, vscode.ConfigurationTarget.Global);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.strictEqual(columnKit.floorGuard.polling, true);
        await cfg.update('watchWhileIdle', undefined, vscode.ConfigurationTarget.Global);
        await new Promise(resolve => setTimeout(resolve, 200));
        assert.strictEqual(columnKit.floorGuard.polling, false, 'the timer outlived the setting');
    });

    test('a pinned column keeps its width through Even and through a new group', async function () {
        // CK-18. The feature nobody in the ecosystem ships, and the thing
        // evenEditorWidths cannot do: it redistributes every group in the grid.
        this.timeout(30000);
        const columnKit = await api();
        const PINNED = 400;

        try {
            await quietly(async () => {
                const width = (await settle()).reduce((a, b) => a + b, 0);
                assert.ok(width - PINNED >= FLOOR, `editor area ${width} too narrow for this setup`);
                await vscode.commands.executeCommand('vscode.setEditorLayout', {
                    orientation: 0,
                    groups: [{ size: PINNED }, { size: width - PINNED }]
                });
                return settle();
            });
            await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
            await new Promise(resolve => setTimeout(resolve, 200));

            await vscode.commands.executeCommand('columnkit.pinColumn');
            assert.match(columnKit.lastNotification()?.message ?? '', /pinned at/);

            await vscode.commands.executeCommand('columnkit.even');
            await new Promise(resolve => setTimeout(resolve, 400));
            const evened = await settle();
            assert.strictEqual(
                evened[0],
                PINNED,
                `Even moved the pinned column: ${JSON.stringify(evened)}`
            );

            // A third column has to take its space from the unpinned one.
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [{ size: 1 }, { size: 1 }, { size: 1 }]
            });
            await settle();
            for (let waited = 0; waited < 4000; waited += 200) {
                if ((await settle())[0] === PINNED) {
                    break;
                }
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            const opened = await settle();
            assert.strictEqual(
                opened[0],
                PINNED,
                `the new group took space from the pinned column: ${JSON.stringify(opened)}`
            );
            assert.ok(
                Math.abs(opened[1] - opened[2]) <= 1,
                `the free columns were not evened: ${JSON.stringify(opened)}`
            );
        } finally {
            await columnKit.clearPins();
        }
    });

    test('puts a remembered layout back, and only when asked to', async function () {
        // CK-22. Stored per workspace against the width it was measured at.
        this.timeout(30000);
        const columnKit = await api();
        const cfg = vscode.workspace.getConfiguration('columnkit');

        const saved = await quietly(async () => {
            const width = (await settle()).reduce((a, b) => a + b, 0);
            assert.ok(width - 560 >= FLOOR, `editor area ${width} too narrow for this setup`);
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: [{ size: width - 560 }, { size: 280 }, { size: 280 }]
            });
            return settle();
        });

        // With the setting off nothing is kept, so a restore has nothing to do.
        assert.strictEqual(
            await columnKit.restoreRememberedLayout(),
            false,
            'restored something while the setting was off'
        );

        await cfg.update('rememberLayout', true, vscode.ConfigurationTarget.Global);
        try {
            await columnKit.rememberLayout();

            await vscode.commands.executeCommand('columnkit.even');
            const evened = await settle();
            assert.notDeepStrictEqual(evened, saved, 'the setup did not change anything');

            assert.strictEqual(await columnKit.restoreRememberedLayout(), true);
            assert.deepStrictEqual(await settle(), saved, 'the widths did not come back');
        } finally {
            await cfg.update('rememberLayout', undefined, vscode.ConfigurationTarget.Global);
            await new Promise(resolve => setTimeout(resolve, 150));
        }
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
