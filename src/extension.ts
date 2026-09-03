import * as vscode from 'vscode';
import {
    EditorLayout,
    LayoutHistory,
    correctFloor,
    describeColumnChange,
    floorRisk,
    isFlat,
    measureEditorWidth
} from './layout';

const CONFIG_SECTION = 'columnkit';

/** Coalesces the burst of activation events VS Code fires when focus moves. */
const AUTO_CORRECT_DEBOUNCE_MS = 120;

/**
 * How long the floor guard stands down after an undo.
 *
 * Must outlast the debounce plus the write round-trip, because the tab-group
 * event a layout write produces arrives after the write resolves.
 */
const UNDO_SETTLE_MS = 400;

/** Sizes handed to vscode.setEditorLayout are proportions of the editor area. */
interface EditorGroupLayout {
    orientation: 0 | 1;
    groups: { size: number }[];
}

function config() {
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
}

function currentColumnCount(): number {
    return vscode.window.tabGroups.all.length;
}

async function readLayout(): Promise<EditorLayout | undefined> {
    try {
        return await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
    } catch {
        return undefined;
    }
}

/**
 * VS Code expands any editor group whose width is exactly its minimum width,
 * on every click into it. See doRestoreGroup in the workbench bundle. Splitting
 * the editor area into too many columns parks them all on that floor, so warn
 * rather than silently handing the user the behaviour they are trying to avoid.
 */
function assessFloorRisk(previous: EditorLayout | undefined, columns: number): boolean {
    return floorRisk(
        previous && measureEditorWidth(previous),
        columns,
        config().get<number>('minGroupWidth', 220)
    );
}

/** User-initiated layout changes only. Floor corrections never land here. */
const history = new LayoutHistory();

/** Set by activate(). Undo needs it to hold corrections off during a restore. */
let floorGuard: FloorGuard | undefined;

async function remember(): Promise<EditorLayout | undefined> {
    const layout = await readLayout();
    if (layout) {
        history.record(layout);
    }
    return layout;
}

async function evenColumns(): Promise<void> {
    await remember();
    await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
}

async function undoLayout(): Promise<void> {
    const previous = history.pop();
    if (!previous) {
        vscode.window.setStatusBarMessage('ColumnKit: nothing to undo.', 3000);
        return;
    }
    // The restored geometry is the user's own, and it may legitimately hold a
    // group on the floor. Stand the guard down first, or its correction would
    // undo the undo.
    floorGuard?.suspendFor(UNDO_SETTLE_MS);
    await vscode.commands.executeCommand('vscode.setEditorLayout', previous);
    vscode.window.setStatusBarMessage('ColumnKit: layout restored.', 3000);
}

async function setColumns(columns: number): Promise<void> {
    const before = currentColumnCount();
    // One read serves both the undo ring and the width measurement.
    const previous = await remember();
    const size = 1 / columns;
    const layout: EditorGroupLayout = {
        orientation: 0,
        groups: Array.from({ length: columns }, () => ({ size }))
    };

    await vscode.commands.executeCommand('vscode.setEditorLayout', layout);

    vscode.window.setStatusBarMessage(
        describeColumnChange({ columns, before, floorRisk: assessFloorRisk(previous, columns) }),
        6000
    );
}

async function pickColumns(): Promise<void> {
    const current = currentColumnCount();
    const items: vscode.QuickPickItem[] = [];

    for (let n = 1; n <= 12; n++) {
        items.push({
            label: `${n}`,
            description: n === 1 ? 'column' : 'columns',
            detail:
                n === current
                    ? 'Current layout. Picking this evens the widths.'
                    : n < current
                        ? `Merges ${current - n} column${current - n === 1 ? '' : 's'} into the last one.`
                        : `Adds ${n - current} empty column${n - current === 1 ? '' : 's'}.`
        });
    }

    // Reached from the status bar picker so undo has an affordance without
    // adding another permanent status bar item.
    const UNDO = '$(discard) Undo last layout change';
    if (history.size > 0) {
        items.unshift({ label: UNDO, description: `${history.size} step${history.size === 1 ? '' : 's'} available` });
    }

    const choice = await vscode.window.showQuickPick(items, {
        title: 'ColumnKit',
        placeHolder: `Column count (currently ${current})`
    });

    if (!choice) {
        return;
    }
    if (choice.label === UNDO) {
        await undoLayout();
        return;
    }
    await setColumns(Number(choice.label));
}

class StatusBar {
    private items: vscode.StatusBarItem[] = [];

    /**
     * Registers once, at construction. Pushing each item into the extension's
     * subscriptions on every rebuild left the old entries behind, so the array
     * grew for the life of the session every time a setting changed.
     */
    constructor(context: vscode.ExtensionContext) {
        context.subscriptions.push({ dispose: () => this.dispose() });
    }

    /** Read by the tests; there is no API to enumerate status bar items. */
    get contributed(): readonly vscode.StatusBarItem[] {
        return this.items;
    }

    /**
     * Creates an item with its label and name set alongside its text, so the
     * three cannot drift apart.
     *
     * `text` is announced literally by screen readers, codicon markup and all,
     * so `$(layout)` reads as "layout" and a preset reads as the bare number
     * "4". An accessibilityInformation.label replaces the text AND suppresses
     * the tooltip append, so it has to stand on its own. `name` is the only
     * thing that lets someone who hid an item find it again in the status bar's
     * context menu.
     */
    private add(
        alignment: vscode.StatusBarAlignment,
        priority: number,
        spec: { text: string; name: string; label: string; tooltip: string; command: string }
    ): void {
        const item = vscode.window.createStatusBarItem(alignment, priority);
        item.text = spec.text;
        item.name = spec.name;
        item.accessibilityInformation = { label: spec.label, role: 'button' };
        item.tooltip = spec.tooltip;
        item.command = spec.command;
        this.items.push(item);
    }

    rebuild(): void {
        this.dispose();

        const cfg = config();
        const alignment =
            cfg.get<string>('statusBarAlignment', 'left') === 'right'
                ? vscode.StatusBarAlignment.Right
                : vscode.StatusBarAlignment.Left;

        // Higher priority keeps the group together and to the outside edge.
        let priority = 1000;

        this.add(alignment, priority--, {
            text: '$(split-horizontal) Even',
            name: 'ColumnKit: Even Out Columns',
            label: 'Even out editor columns',
            tooltip: 'ColumnKit: even out every open column, keeping the count as-is',
            command: 'columnkit.even'
        });

        for (const n of cfg.get<number[]>('statusBarPresets', [4, 6, 8])) {
            if (!Number.isInteger(n) || n < 1 || n > 12) {
                continue;
            }
            this.add(alignment, priority--, {
                text: `${n}`,
                name: `ColumnKit: ${n} Columns`,
                label: `${n} equal editor ${n === 1 ? 'column' : 'columns'}`,
                tooltip: `ColumnKit: ${n} equal columns`,
                command: `columnkit.columns${n}`
            });
        }

        this.add(alignment, priority--, {
            text: '$(layout)',
            name: 'ColumnKit: Column Count Picker',
            label: 'Choose editor column count',
            tooltip: 'ColumnKit: pick a column count',
            command: 'columnkit.pickColumns'
        });

        for (const item of this.items) {
            item.show();
        }
    }

    dispose(): void {
        for (const item of this.items) {
            item.dispose();
        }
        this.items = [];
    }
}

/**
 * Keeps every editor group off its minimum width, so the expand never arms.
 *
 * VS Code's EditorPart.doRestoreGroup expands a group when
 * `viewSize.width === group.minimumWidth`. The comparison is strict equality, so
 * a group one pixel clear of the floor is never touched.
 *
 * Reacting to activation cannot work: doRestoreGroup runs synchronously inside
 * doSetGroupActive, in the renderer, before the activation event is fired. By the
 * time the extension host is told, the expand has already happened. So this
 * disarms every group ahead of any click rather than trying to win a race it
 * cannot win.
 *
 * Driven by onDidChangeTabGroups rather than onDidChangeActiveTextEditor because
 * the latter only fires for text editors and never for webview panes, which is
 * what AI chat sessions are.
 *
 * Known gap: a sash drag raises no event, so a group the user drags onto the
 * floor stays armed until the next tab-group change.
 */
class FloorGuard {
    private timer: NodeJS.Timeout | undefined;
    private correcting = false;
    private pending = false;
    private disposed = false;

    /** Corrections applied since activation. Read by the tests. */
    corrections = 0;

    /** Wall-clock deadline before which no correction runs. */
    private suspendedUntil = 0;

    /** Holds corrections off while a deliberate layout write settles. */
    suspendFor(ms: number): void {
        this.suspendedUntil = Date.now() + ms;
    }

    /** Ends a suspension early. The window is global, so tests must clear it. */
    resume(): void {
        this.suspendedUntil = 0;
    }

    private get suspended(): boolean {
        return Date.now() < this.suspendedUntil;
    }

    schedule(): void {
        if (this.disposed || this.suspended || !config().get<boolean>('autoCorrect', true)) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.run(), AUTO_CORRECT_DEBOUNCE_MS);
    }

    async run(): Promise<boolean> {
        // Serialise against an in-flight correction. Anything that arrives while
        // one is running is remembered and retried, not dropped.
        if (this.correcting) {
            this.pending = true;
            return false;
        }
        if (this.disposed) {
            return false;
        }
        this.correcting = true;
        try {
            // Whether THIS invocation changed anything. Reporting the lifetime
            // counter here would make every later no-op look like a success.
            let applied = false;
            do {
                this.pending = false;
                if (!(await this.correctOnce())) {
                    break;
                }
                applied = true;
            } while (this.pending && !this.disposed);
            return applied;
        } finally {
            this.correcting = false;
        }
    }

    private async correctOnce(): Promise<boolean> {
        // Re-read the setting and the suspension here rather than at schedule
        // time, so turning it off, or starting an undo, inside the debounce
        // window still cancels an already-scheduled correction.
        if (this.disposed || this.suspended || !config().get<boolean>('autoCorrect', true)) {
            return false;
        }
        try {
            const layout = await readLayout();
            if (!layout || this.disposed) {
                return false;
            }

            // A nested grid mixes widths and heights in one size list, and a flat
            // write would collapse it. Leaf count always equals group count, so
            // only the shape can tell us; bail rather than guess.
            if (!isFlat(layout.groups) || layout.groups.length < 2) {
                return false;
            }

            const floor = config().get<number>('minGroupWidth', 220);
            const sizes = layout.groups.map(n => n.size ?? 0);

            // A group created moments ago reports the raw weight it was written
            // with until the grid lays it out, so a read straight after a write
            // can return values like 0.01 instead of pixels. Acting on those
            // would be arithmetic on garbage.
            if (sizes.some(size => size < 1)) {
                return false;
            }

            const correction = correctFloor(sizes, floor);
            if (!correction) {
                return false;
            }

            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: layout.orientation,
                groups: correction.sizes.map(size => ({ size }))
            });
            this.corrections++;
            return true;
        } catch {
            // Never let a layout read or write break editor handling.
            return false;
        }
    }
    dispose(): void {
        this.disposed = true;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
    }
}

export interface ColumnKitApi {
    floorGuard: FloorGuard;
    history: LayoutHistory;
    statusBar: { readonly contributed: readonly vscode.StatusBarItem[] };
    /** Extension subscription count. Exposed so the tests can watch for leaks. */
    subscriptionCount(): number;
}

export function activate(context: vscode.ExtensionContext): ColumnKitApi {
    context.subscriptions.push(
        vscode.commands.registerCommand('columnkit.even', evenColumns),
        vscode.commands.registerCommand('columnkit.pickColumns', pickColumns),
        vscode.commands.registerCommand('columnkit.undoLayout', undoLayout)
    );

    // Preset commands need to exist as real command ids so status bar items and
    // the command palette can both reach them. Registered across the whole
    // allowed range so any statusBarPresets value resolves to a live command.
    for (let n = 1; n <= 12; n++) {
        context.subscriptions.push(
            vscode.commands.registerCommand(`columnkit.columns${n}`, () => setColumns(n))
        );
    }

    const statusBar = new StatusBar(context);
    statusBar.rebuild();

    const guard = new FloorGuard();
    floorGuard = guard;
    context.subscriptions.push(
        { dispose: () => guard.dispose() },
        vscode.window.tabGroups.onDidChangeTabGroups(() => guard.schedule())
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (
                event.affectsConfiguration(`${CONFIG_SECTION}.statusBarPresets`) ||
                event.affectsConfiguration(`${CONFIG_SECTION}.statusBarAlignment`)
            ) {
                statusBar.rebuild();
            }
        })
    );

    // There is no API to enumerate status bar items or observe the guard from
    // outside, so the tests reach them through the activation result.
    return {
        floorGuard: guard,
        history,
        statusBar,
        subscriptionCount: () => context.subscriptions.length
    };
}

export function deactivate(): void {
    floorGuard = undefined;
    // Status bar items are disposed through the extension subscriptions.
}
