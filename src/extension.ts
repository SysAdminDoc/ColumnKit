import * as vscode from 'vscode';
import {
    DEFAULT_FLOOR,
    EditorLayout,
    LayoutHistory,
    SETTINGS_FLOOR,
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
    // The warning is about ordinary editors. A wider pane like Settings raises
    // the bar further, but it will not be in every column after a split.
    return floorRisk(
        previous && measureEditorWidth(previous, DEFAULT_FLOOR),
        columns,
        DEFAULT_FLOOR
    );
}

/**
 * The minimum width the pane in this column asks for.
 *
 * VS Code compares a group against its own active pane's `minimumWidth`, not a
 * global constant, so a Settings tab arms the expand at 500 where a chat panel
 * arms it at 220. The Settings editor has no `TabInput` class of its own, which
 * leaves its label as the only signal an extension gets.
 */
function floorForTab(tab: vscode.Tab | undefined): number {
    if (tab && tab.input === undefined && tab.label === 'Settings') {
        return SETTINGS_FLOOR;
    }
    return DEFAULT_FLOOR;
}

/**
 * A floor per layout leaf, in grid order.
 *
 * Leaves are indexed the way ViewColumn is, so groups are matched on
 * `viewColumn` rather than on their position in `tabGroups.all`, which is
 * creation order and disagrees as soon as anything is split to the left.
 */
function floorsForColumns(count: number): number[] {
    const byColumn = new Map<number, vscode.TabGroup>();
    for (const group of vscode.window.tabGroups.all) {
        byColumn.set(group.viewColumn, group);
    }
    return Array.from({ length: count }, (_, i) => floorForTab(byColumn.get(i + 1)?.activeTab));
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
    floorGuard?.suspendFor(UNDO_SETTLE_MS);
    try {
        await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
    } catch {
        history.pop();
        vscode.window.setStatusBarMessage('ColumnKit: could not even out the columns.', 3000);
        return;
    }
    floorGuard?.suspendFor(UNDO_SETTLE_MS);
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
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', previous);
    } catch {
        // The entry was already off the ring. Put it back rather than losing a
        // step to a write that never landed, and do not claim a restore.
        history.record(previous);
        vscode.window.setStatusBarMessage('ColumnKit: could not restore the layout.', 3000);
        return;
    }
    // Re-arm from the moment the write actually landed. The window opened above
    // has been funding the write's own round-trip, and the tab-group event it
    // produces does not arrive until afterwards.
    floorGuard?.suspendFor(UNDO_SETTLE_MS);
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

    // Hold the guard off across the write. Both paths read the layout and then
    // write a new one, and a correction landing in that gap would be computed
    // from the group count we are in the middle of replacing.
    floorGuard?.suspendFor(UNDO_SETTLE_MS);
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
    } catch {
        // Nothing changed, so the entry recorded above would be a phantom step.
        history.pop();
        vscode.window.setStatusBarMessage('ColumnKit: could not change the column count.', 3000);
        return;
    }
    floorGuard?.suspendFor(UNDO_SETTLE_MS);

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
        spec: {
            text: string;
            name: string;
            label: string;
            tooltip: string | vscode.MarkdownString;
            command: string;
        }
    ): void {
        const item = vscode.window.createStatusBarItem(alignment, priority);
        item.text = spec.text;
        item.name = spec.name;
        item.accessibilityInformation = { label: spec.label, role: 'button' };
        item.tooltip = spec.tooltip;
        item.command = spec.command;
        this.items.push(item);
    }

    /**
     * The hover menu on the single default item.
     *
     * VS Code gives a status bar item one command and no secondary click, but a
     * trusted MarkdownString tooltip renders command links that activate on a
     * single click. That is how the presets and the picker stay one click away
     * without contributing four more items.
     */
    private menu(): vscode.MarkdownString {
        const menu = new vscode.MarkdownString(
            'Even out every open column, keeping the count as-is.\n\n' +
            [2, 3, 4, 6, 8].map(n => `[${n} columns](command:columnkit.columns${n})`).join(' · ') +
            '\n\n[Choose a count...](command:columnkit.pickColumns)' +
            ' · [Undo layout change](command:columnkit.undoLayout)'
        );
        // Command links are inert without this.
        menu.isTrusted = true;
        return menu;
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

        const presets = cfg
            .get<number[]>('statusBarPresets', [])
            .filter(n => Number.isInteger(n) && n >= 1 && n <= 12);

        // One item by default. VS Code's own status bar guidance is to
        // contribute a single entry unless more are necessary, and the presets
        // stay reachable through this one's hover menu.
        this.add(alignment, priority--, {
            text: '$(split-horizontal) Even',
            name: 'ColumnKit: Even Out Columns',
            label: 'Even out editor columns',
            tooltip: this.menu(),
            command: 'columnkit.even'
        });

        for (const n of presets) {
            this.add(alignment, priority--, {
                text: `${n}`,
                name: `ColumnKit: ${n} Columns`,
                label: `${n} equal editor ${n === 1 ? 'column' : 'columns'}`,
                tooltip: `ColumnKit: ${n} equal columns`,
                command: `columnkit.columns${n}`
            });
        }

        // Only alongside the numbered buttons. On its own the picker duplicates
        // what the hover menu already offers.
        if (presets.length > 0) {
            this.add(alignment, priority--, {
                text: '$(layout)',
                name: 'ColumnKit: Column Count Picker',
                label: 'Choose editor column count',
                tooltip: 'ColumnKit: pick a column count',
                command: 'columnkit.pickColumns'
            });
        }

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
        if (this.disposed) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        // Defer past a suspension rather than dropping the event. Returning
        // early here would discard the only notification we get, and nothing
        // re-arms when the deadline lapses, so a group floored during an undo
        // would stay armed until some later, unrelated tab-group change.
        const held = Math.max(0, this.suspendedUntil - Date.now());
        this.timer = setTimeout(() => void this.run(), held + AUTO_CORRECT_DEBOUNCE_MS);
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
        if (this.disposed) {
            return false;
        }
        try {
            // Read the setting and the suspension here rather than at schedule
            // time, so turning it off, or starting an undo, inside the debounce
            // window still cancels an already-scheduled correction. Inside the
            // try because getConfiguration throws once the host starts tearing
            // down, and this runs from a timer with nobody to catch it.
            if (this.suspended || !config().get<boolean>('autoCorrect', true)) {
                return false;
            }
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

            const sizes = layout.groups.map(n => n.size ?? 0);
            const floors = floorsForColumns(sizes.length);

            // A group created moments ago reports the raw weight it was written
            // with until the grid lays it out, so a read straight after a write
            // can return values like 0.01 instead of pixels. Acting on those
            // would be arithmetic on garbage.
            if (sizes.some(size => size < 1)) {
                return false;
            }

            const correction = correctFloor(sizes, floors);
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
    // Module state outlives the extension host's activation, so a second
    // activation would otherwise inherit the previous session's undo stack.
    history.clear();
    // Status bar items are disposed through the extension subscriptions.
}
