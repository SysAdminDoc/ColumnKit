import * as vscode from 'vscode';
import { EditorLayout, correctFloor, describeColumnChange, leaves } from './layout';

const CONFIG_SECTION = 'columnkit';

/** Coalesces the burst of activation events VS Code fires when focus moves. */
const AUTO_CORRECT_DEBOUNCE_MS = 120;

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
function estimateFloorRisk(columns: number): boolean {
    const minWidth = config().get<number>('minGroupWidth', 220);
    // No API exposes the editor area width, so approximate from the window.
    // devicePixelRatio is not available in the extension host either, which is
    // why this stays a soft warning instead of a hard block.
    const assumedEditorWidth = 1920;
    return columns * minWidth > assumedEditorWidth;
}

async function evenColumns(): Promise<void> {
    await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
}

async function setColumns(columns: number): Promise<void> {
    const before = currentColumnCount();
    const size = 1 / columns;
    const layout: EditorGroupLayout = {
        orientation: 0,
        groups: Array.from({ length: columns }, () => ({ size }))
    };

    await vscode.commands.executeCommand('vscode.setEditorLayout', layout);

    vscode.window.setStatusBarMessage(
        describeColumnChange({ columns, before, floorRisk: estimateFloorRisk(columns) }),
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

    const choice = await vscode.window.showQuickPick(items, {
        title: 'ColumnKit',
        placeHolder: `Column count (currently ${current})`
    });

    if (choice) {
        await setColumns(Number(choice.label));
    }
}

class StatusBar {
    private items: vscode.StatusBarItem[] = [];

    constructor(private readonly context: vscode.ExtensionContext) { }

    rebuild(): void {
        this.dispose();

        const cfg = config();
        const alignment =
            cfg.get<string>('statusBarAlignment', 'left') === 'right'
                ? vscode.StatusBarAlignment.Right
                : vscode.StatusBarAlignment.Left;

        // Higher priority keeps the group together and to the outside edge.
        let priority = 1000;

        const even = vscode.window.createStatusBarItem(alignment, priority--);
        even.text = '$(split-horizontal) Even';
        even.tooltip = 'ColumnKit: even out every open column, keeping the count as-is';
        even.command = 'columnkit.even';
        this.items.push(even);

        for (const n of cfg.get<number[]>('statusBarPresets', [4, 6, 8])) {
            if (!Number.isInteger(n) || n < 1 || n > 12) {
                continue;
            }
            const item = vscode.window.createStatusBarItem(alignment, priority--);
            item.text = `${n}`;
            item.tooltip = `ColumnKit: ${n} equal columns`;
            item.command = `columnkit.columns${n}`;
            this.items.push(item);
        }

        const picker = vscode.window.createStatusBarItem(alignment, priority--);
        picker.text = '$(layout)';
        picker.tooltip = 'ColumnKit: pick a column count';
        picker.command = 'columnkit.pickColumns';
        this.items.push(picker);

        for (const item of this.items) {
            item.show();
            this.context.subscriptions.push(item);
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
 * Keeps the active group off its minimum width.
 *
 * VS Code's EditorPart.doRestoreGroup expands a group on activation when
 * `viewSize.width === group.minimumWidth`. The comparison is strict equality, so
 * a group one pixel clear of the floor is never touched. Raising the group as it
 * becomes active prevents the expand instead of undoing it afterwards.
 *
 * Driven by onDidChangeTabGroups rather than onDidChangeActiveTextEditor because
 * the latter only fires for text editors and never for webview panes, which is
 * what AI chat sessions are.
 */
class FloorGuard {
    private timer: NodeJS.Timeout | undefined;
    private correcting = false;
    private disposed = false;

    /** Corrections applied since activation. Read by the tests. */
    corrections = 0;

    schedule(): void {
        if (this.disposed || !config().get<boolean>('autoCorrect', true)) {
            return;
        }
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => void this.run(), AUTO_CORRECT_DEBOUNCE_MS);
    }

    async run(): Promise<boolean> {
        // A correction changes geometry, which re-enters this same event. Without
        // this guard the handler would drive itself.
        if (this.correcting || this.disposed) {
            return false;
        }
        this.correcting = true;
        try {
            const layout = await readLayout();
            if (!layout) {
                return false;
            }
            const nodes = leaves(layout.groups);
            const groups = vscode.window.tabGroups.all;

            // A mismatch means the leaf order cannot be trusted to line up with
            // ViewColumn: an auxiliary window is open, or the grid is nested in a
            // shape this does not model. Documented no-op rather than a guess.
            if (nodes.length !== groups.length || nodes.length < 2) {
                return false;
            }

            const activeIndex = groups.findIndex(g => g.isActive);
            if (activeIndex < 0) {
                return false;
            }

            const floor = config().get<number>('minGroupWidth', 220);
            const sizes = nodes.map(n => n.size ?? 0);
            const correction = correctFloor(sizes, activeIndex, floor);
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
            // Never let a layout read or write break focus handling.
            return false;
        } finally {
            this.correcting = false;
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
}

export function activate(context: vscode.ExtensionContext): ColumnKitApi {
    context.subscriptions.push(
        vscode.commands.registerCommand('columnkit.even', evenColumns),
        vscode.commands.registerCommand('columnkit.pickColumns', pickColumns)
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
    context.subscriptions.push({ dispose: () => statusBar.dispose() });

    const floorGuard = new FloorGuard();
    context.subscriptions.push(
        { dispose: () => floorGuard.dispose() },
        vscode.window.tabGroups.onDidChangeTabGroups(() => floorGuard.schedule())
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
    return { floorGuard };
}

export function deactivate(): void {
    // Status bar items are disposed through the extension subscriptions.
}
