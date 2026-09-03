import * as vscode from 'vscode';

const CONFIG_SECTION = 'columnkit';

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

    if (columns < before) {
        const merged = before - columns;
        vscode.window.setStatusBarMessage(
            `ColumnKit: ${columns} columns, ${merged} merged into the last one. Nothing was closed.`,
            5000
        );
    } else if (columns > before) {
        vscode.window.setStatusBarMessage(
            `ColumnKit: ${columns} columns, ${columns - before} empty.`,
            5000
        );
    } else {
        vscode.window.setStatusBarMessage(`ColumnKit: ${columns} columns, evened.`, 3000);
    }

    if (estimateFloorRisk(columns)) {
        vscode.window.setStatusBarMessage(
            `ColumnKit: ${columns} columns may sit at the minimum width and expand on click.`,
            6000
        );
    }
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

export function activate(context: vscode.ExtensionContext): void {
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
}

export function deactivate(): void {
    // Status bar items are disposed through the extension subscriptions.
}
