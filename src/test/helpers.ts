import * as assert from 'assert';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';
import { EditorLayout, leaves } from '../layout';

/**
 * Shared test plumbing.
 *
 * Every suite needs the same handful of things: reach the extension, read the
 * layout, wait for the grid to settle, park a column on the floor. They were
 * copied into four files and had already drifted, with two `parkOnFloor`
 * variants and a `settle` that threw in one file and returned in another.
 *
 * Not named `*.test.ts`, so the runner does not treat it as a suite.
 */

/** VS Code's editor minimum, the width that arms the expand. */
export const FLOOR = 220;

export async function api(): Promise<ColumnKitApi> {
    const ext = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit');
    assert.ok(ext, 'ColumnKit extension should be present in the test host');
    return ext.isActive ? ext.exports : await ext.activate();
}

export function wait(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function readLayout(): Promise<EditorLayout> {
    return vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
}

export async function readSizes(): Promise<number[]> {
    return leaves((await readLayout()).groups).map(node => node.size ?? 0);
}

/**
 * Waits for the grid to lay out.
 *
 * A group written moments ago reports the raw weight it was created with, not a
 * pixel width, so reading straight after a write yields values like 0.01.
 */
export async function settle(): Promise<number[]> {
    for (let attempt = 0; attempt < 50; attempt++) {
        const sizes = await readSizes();
        if (sizes.every(size => size >= 1)) {
            return sizes;
        }
        await wait(20);
    }
    throw new Error(
        'editor layout never settled into pixel values; last read: ' +
        JSON.stringify(await readSizes())
    );
}

/**
 * Runs a setup step with the guard held off, then leaves it armed and idle.
 *
 * Writing a floored layout schedules a correction that lands about 120ms later,
 * inside the window a setup needs to read its own result back. Any test that
 * then asserts on the floored state is racing it. The hold is the same mechanism
 * the commands use, for the same reason.
 */
export async function quietly<T>(setup: () => Promise<T>): Promise<T> {
    const guard = (await api()).floorGuard;
    guard.beginHold();
    try {
        return await setup();
    } finally {
        guard.endHold(0);
        guard.resume();
    }
}

/**
 * Produces three groups with the last two sitting exactly on the floor.
 *
 * Asks for the floor outright rather than asking for less and relying on VS
 * Code to clamp upward. That clamp is not dependable: a pixel request of
 * [540, 170, 170] against an 880px area came back verbatim.
 */
export async function parkOnFloor(): Promise<number[]> {
    return quietly(async () => {
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
    });
}

/** Indexes of every group sitting exactly on the floor. */
export function flooredIndexes(sizes: number[]): number[] {
    return sizes.map((size, i) => (size === FLOOR ? i : -1)).filter(i => i >= 0);
}

/** Empties the undo ring and re-arms the guard. */
export async function drainHistory(): Promise<ColumnKitApi> {
    const columnKit = await api();
    while (columnKit.history.pop()) {
        // discard
    }
    columnKit.floorGuard.resume();
    return columnKit;
}

/** Column each open document sits in, keyed by its resource. */
export function placement(): Map<string, number> {
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
export async function fillColumns(count: number): Promise<string[]> {
    const opened: string[] = [];
    for (let column = 1; column <= count; column++) {
        const doc = await vscode.workspace.openTextDocument({
            content: `probe column ${column}`,
            language: 'plaintext'
        });
        await vscode.window.showTextDocument(doc, { viewColumn: column, preview: false });
        opened.push(doc.uri.toString());
    }
    return opened;
}

/**
 * Leaves the host as the next suite expects it: no editors, no locks, one
 * column, orientation 0, and an idle guard.
 *
 * A stale lock made unrelated tests report zero writes, and a stack of rows left
 * behind made the next suite measure a width from a list of heights.
 */
export async function resetHost(): Promise<void> {
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
    await wait(150);
    (await api()).floorGuard.resume();
}
