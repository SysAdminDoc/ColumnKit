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
 * Produces a group parked exactly on the floor. Requesting a share narrower than
 * the minimum makes VS Code clamp it to precisely `minimumWidth`, which is the
 * strict-equality value doRestoreGroup expands on.
 */
async function parkOnFloor(): Promise<number[]> {
    await vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0,
        groups: [{ size: 0.02 }, { size: 0.98 }]
    });
    return readSizes();
}

async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

suite('FloorGuard', () => {
    test('a below-minimum request really does land on the floor', async () => {
        const sizes = await parkOnFloor();
        assert.strictEqual(
            sizes[0],
            FLOOR,
            `expected the narrow group to clamp to exactly ${FLOOR}, got ${sizes[0]}`
        );
    });

    test('raises the active group clear of the floor', async () => {
        await parkOnFloor();
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');

        const columnKit = await api();
        const applied = await columnKit.floorGuard.run();
        assert.ok(applied, 'guard should have applied a correction');

        const after = await readSizes();
        assert.ok(
            after[0] > FLOOR,
            `group still on the floor at ${after[0]}; the expand trigger is still armed`
        );
        assert.strictEqual(after[0], FLOOR + CORRECTION_MARGIN);
    });

    test('is idempotent, so a corrected layout is left alone', async () => {
        await parkOnFloor();
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const columnKit = await api();

        assert.strictEqual(await columnKit.floorGuard.run(), true, 'first run corrects');
        const afterFirst = await readSizes();
        assert.strictEqual(await columnKit.floorGuard.run(), false, 'second run is a no-op');
        assert.deepStrictEqual(await readSizes(), afterFirst, 'a no-op must not move anything');
    });

    test('a correction does not re-enter itself', async () => {
        await parkOnFloor();
        await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
        const columnKit = await api();

        const before = columnKit.floorGuard.corrections;
        // Fire concurrently. The re-entrancy guard must collapse these to one write.
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
});
