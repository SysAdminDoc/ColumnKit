import * as vscode from 'vscode';
import {
    DEFAULT_FLOOR,
    EditorLayout,
    LayoutHistory,
    ColumnFloor,
    SETTINGS_FLOOR,
    TabPlacement,
    correctFloor,
    describeColumnChange,
    floorRisk,
    isFlat,
    leaves,
    maxColumns,
    measureEditorWidth
} from './layout';
import { Release, UpdateDecision, decide, isRelease, shouldCheck } from './update';

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
        previous && measureEditorWidth(previous, DEFAULT_FLOOR),
        columns,
        currentFloors(previous),
        DEFAULT_FLOOR
    );
}

/**
 * The two widths that matter for the pane in a column of width `size`.
 *
 * VS Code compares a group against its own active pane's `minimumWidth`, not a
 * global constant, and there is no API that reports it. The panes that override
 * it share one observable trait: no `TabInput` class, so `tab.input` is
 * undefined. Matching on the label instead is worse than useless, being
 * localized.
 *
 * But `input === undefined` is not a Settings detector. Measured on 1.136.1:
 * Keyboard Shortcuts, the Search editor, Welcome and the Extension editor all
 * report undefined too, and all four sit happily at 220. Only Settings is
 * clamped to 500, and VS Code does that clamping itself the moment the pane
 * opens. So the width the column already has is the evidence: a column at
 * exactly 500 holding an unclassifiable pane is Settings on its floor and must
 * be raised, while the same pane at 300 is not on any floor and must be left
 * alone. Assuming 500 for all of them dragged 300px columns out to 524.
 *
 * The donor side stays pessimistic. Taking space from a pane that really does
 * want 500 gets clamped straight back to exactly 500, which is the value that
 * arms the expand, so the correction would create the bug it exists to prevent.
 */
function floorForTab(tab: vscode.Tab | undefined, size: number): ColumnFloor {
    if (tab && tab.input === undefined) {
        return {
            floor: size === SETTINGS_FLOOR ? SETTINGS_FLOOR : DEFAULT_FLOOR,
            donorFloor: SETTINGS_FLOOR
        };
    }
    return { floor: DEFAULT_FLOOR, donorFloor: DEFAULT_FLOOR };
}

/**
 * A floor pair per layout leaf, in grid order.
 *
 * `getEditorLayout` reports the ACTIVE editor part, while `tabGroups.all` spans
 * every part with `viewColumn` numbered across all of them. With a floating
 * window focused, leaf i of that window's grid would be matched against a group
 * in the main window, and the correction would resize a window whose columns
 * were never at risk. When the counts disagree there is no sound mapping, so
 * assume the ordinary floor rather than guess.
 */
function floorsForColumns(sizes: number[]): ColumnFloor[] {
    const groups = vscode.window.tabGroups.all;
    if (groups.length !== sizes.length) {
        return sizes.map(() => ({ floor: DEFAULT_FLOOR, donorFloor: DEFAULT_FLOOR }));
    }
    const byColumn = new Map<number, vscode.TabGroup>();
    for (const group of groups) {
        byColumn.set(group.viewColumn, group);
    }
    return sizes.map((size, i) => floorForTab(byColumn.get(i + 1)?.activeTab, size));
}

/**
 * Floors for the groups currently open, used to size a request before writing.
 *
 * Only the arming width matters here: the question is how much room a column
 * count needs, not who can lend to whom.
 */
function currentFloors(layout: EditorLayout | undefined): number[] {
    if (!layout) {
        return [];
    }
    const sizes = leaves(layout.groups).map(node => node.size ?? 0);
    return floorsForColumns(sizes).map(f => f.floor);
}

/** User-initiated layout changes only. Floor corrections never land here. */
const history = new LayoutHistory();

/** Set by activate(). Undo needs it to hold corrections off during a restore. */
let floorGuard: FloorGuard | undefined;

/**
 * Set by activate(). Quiet by default: VS Code decides the level, and the user
 * raises it with `Developer: Set Log Level` or `--log SysAdminDoc.columnkit:trace`.
 * A bespoke `columnkit.trace` setting would duplicate machinery the editor
 * already has.
 */
let log: vscode.LogOutputChannel | undefined;

/** Where the update check looks. Only ever read, never written to. */
const RELEASES_API = 'https://api.github.com/repos/SysAdminDoc/ColumnKit/releases/latest';

const LAST_CHECKED_KEY = 'update.lastCheckedAt';
const SKIPPED_VERSION_KEY = 'update.skippedVersion';

/** Requests actually issued. Read by the tests to prove silence when disabled. */
let updateRequests = 0;

/** GitHub rejects API requests that do not send one. */
const USER_AGENT = 'ColumnKit-update-check';

/** Release assets are served from a redirect to a storage host. */
const MAX_REDIRECTS = 5;

/** Room for a release body, which is JSON and small. */
const MAX_BODY_BYTES = 1_000_000;

/** Room for a `.vsix`, which is tens of kilobytes today. */
const MAX_VSIX_BYTES = 50 * 1024 * 1024;

/**
 * Body of an https GET, or undefined for any failure at all.
 *
 * Redirects are followed because a release download always is one, and every
 * hop has to stay https. Following a redirect off GitHub is safe here only
 * because the bytes are checked against the release's digest afterwards.
 */
async function httpsGet(
    url: string,
    limit: number,
    redirectsLeft = MAX_REDIRECTS
): Promise<Buffer | undefined> {
    if (!url.startsWith('https://')) {
        return undefined;
    }
    const https = await import('node:https');
    return new Promise<Buffer | undefined>(resolve => {
        const request = https.get(
            url,
            {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/vnd.github+json' },
                timeout: 30000
            },
            response => {
                const status = response.statusCode ?? 0;
                const location = response.headers.location;
                if (status >= 300 && status < 400 && location) {
                    response.resume();
                    if (redirectsLeft <= 0) {
                        resolve(undefined);
                        return;
                    }
                    resolve(httpsGet(new URL(location, url).toString(), limit, redirectsLeft - 1));
                    return;
                }
                if (status !== 200) {
                    log?.debug(`update request: HTTP ${status}`);
                    response.resume();
                    resolve(undefined);
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    size += chunk.length;
                    // A hostile or broken response must not grow without bound
                    // inside the extension host.
                    if (size > limit) {
                        request.destroy();
                        resolve(undefined);
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('end', () => resolve(Buffer.concat(chunks)));
            }
        );
        request.on('timeout', () => request.destroy());
        request.on('error', error => {
            log?.debug(`update request failed: ${error.message}`);
            resolve(undefined);
        });
    });
}

/**
 * Fetches the latest release, or undefined for any failure at all.
 *
 * An update check is a convenience, so nothing it does may surface an error or
 * delay anything the user asked for.
 */
async function fetchLatestRelease(): Promise<Release | undefined> {
    updateRequests++;
    const body = await httpsGet(RELEASES_API, MAX_BODY_BYTES);
    if (!body) {
        return undefined;
    }
    try {
        const parsed: unknown = JSON.parse(body.toString('utf8'));
        return isRelease(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/** Injected by the tests so no test run reaches GitHub. */
export type FetchRelease = () => Promise<Release | undefined>;

/** Injected the same way, so the checksum gate can be exercised offline. */
export type DownloadBytes = (url: string, limit: number) => Promise<Buffer | undefined>;

/**
 * Downloads the asset, checks it against the digest the release published, and
 * installs it only if they agree.
 *
 * Handing the URL straight to `workbench.extensions.installExtension` installs
 * whatever is at the other end: the URI branch of that command downloads and
 * installs with no hash or signature check, and sideloaded VSIX installs skip
 * signature verification entirely.
 */
async function installUpdate(
    context: vscode.ExtensionContext,
    update: UpdateDecision,
    download: DownloadBytes = httpsGet
): Promise<void> {
    const asset = update.asset;
    if (!asset) {
        return;
    }
    const bytes = await download(asset.url, MAX_VSIX_BYTES);
    if (!bytes) {
        notify('ColumnKit: the update could not be downloaded.', 4000);
        return;
    }
    const crypto = await import('node:crypto');
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.sha256) {
        log?.warn(`update rejected: expected ${asset.sha256}, got ${actual}`);
        notify(
            'ColumnKit: the downloaded update did not match its checksum, so it was not installed.',
            6000
        );
        return;
    }

    await vscode.workspace.fs.createDirectory(context.globalStorageUri);
    const file = vscode.Uri.joinPath(context.globalStorageUri, `columnkit-${update.version}.vsix`);
    await vscode.workspace.fs.writeFile(file, bytes);
    try {
        await vscode.commands.executeCommand('workbench.extensions.installExtension', file);
    } finally {
        // Best effort. A leftover file is harmless; failing the install is not.
        try {
            await vscode.workspace.fs.delete(file);
        } catch {
            log?.debug('could not remove the downloaded update');
        }
    }
}

/**
 * Tells the user when a newer release exists.
 *
 * Buttons, unusually for this extension, because the alternative is installing
 * something behind their back. The prompt is an offer rather than a
 * confirmation of an action they already took.
 */
async function checkForUpdate(
    context: vscode.ExtensionContext,
    now = Date.now(),
    fetch: FetchRelease = fetchLatestRelease
): Promise<void> {
    if (!config().get<boolean>('checkForUpdates', true)) {
        return;
    }
    const lastCheckedAt = context.globalState.get<number>(LAST_CHECKED_KEY);
    if (!shouldCheck(lastCheckedAt, now)) {
        return;
    }

    try {
        const release = await fetch();
        if (!release) {
            // Deliberately not recorded. Spending the daily slot on a check that
            // never reached GitHub means one offline start silences the feature
            // for a day; a failure retries on the next activation instead.
            log?.debug('update check: no usable release, will retry');
            return;
        }
        await context.globalState.update(LAST_CHECKED_KEY, now);

        const current = context.extension.packageJSON.version as string;
        const update = decide(current, release, context.globalState.get<string>(SKIPPED_VERSION_KEY));
        if (!update) {
            log?.debug(`update check: ${current} is current`);
            return;
        }

        log?.info(`update available: ${update.version}`);
        const install = update.asset ? 'Update' : undefined;
        const choice = await vscode.window.showInformationMessage(
            `ColumnKit ${update.version} is available. You have ${current}.`,
            ...[install, 'Release notes', 'Skip this version'].filter((x): x is string => !!x)
        );

        if (choice === 'Update') {
            await installUpdate(context, update);
        } else if (choice === 'Release notes') {
            await vscode.env.openExternal(vscode.Uri.parse(update.release.html_url));
        } else if (choice === 'Skip this version') {
            await context.globalState.update(SKIPPED_VERSION_KEY, update.version);
        }
    } catch (error) {
        // Fire and forget from activate(), so an escape here lands as an
        // unhandled rejection in the host log and the promise never settles.
        log?.debug(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export type NotifyChannel = 'statusBar' | 'notification';

/** Set by notify(). The tests cannot observe either channel from outside. */
let lastNotification: { message: string; channel: NotifyChannel } | undefined;

/**
 * Says something to the user through a channel they can actually perceive.
 *
 * The status bar is rendered `role="status"` with `aria-live="off"`, so a
 * screen reader announces nothing that appears there, and setting
 * `accessibilityInformation` on an item suppresses the tooltip append too.
 * Notifications are announced: VS Code pushes every one through an ARIA alert.
 * So when the editor is in screen reader mode the outcome goes to a
 * notification with no buttons, which is a toast rather than a prompt.
 */
function notify(message: string, timeout = 6000): void {
    const screenReader =
        vscode.workspace.getConfiguration('editor').get<string>('accessibilitySupport') === 'on';
    lastNotification = { message, channel: screenReader ? 'notification' : 'statusBar' };
    log?.trace(`notify (${lastNotification.channel}): ${message}`);

    if (screenReader) {
        void vscode.window.showInformationMessage(message);
    } else {
        vscode.window.setStatusBarMessage(message, timeout);
    }
}

/**
 * Identity for a tab that survives a merge.
 *
 * Tab objects are rebuilt whenever the tab model changes, so a reference taken
 * before a layout write is stale after it. The resource is the stable half
 * where a tab has one: `uri` on text, custom and notebook inputs, `modified` on
 * a diff. Webview and terminal tabs have neither, so the label carries them.
 * Read structurally rather than through `instanceof` so a tab kind this build of
 * @types/vscode does not know about still contributes its resource.
 */
function tabKey(tab: vscode.Tab): string {
    const input = tab.input as { uri?: vscode.Uri; modified?: vscode.Uri } | undefined;
    const uri = input?.uri ?? input?.modified;
    return `${uri ? uri.toString() : ''} ${tab.label}`;
}

/** Where every open tab sits right now, in grid order. */
function snapshotTabs(): TabPlacement[] {
    const placements: TabPlacement[] = [];
    for (const group of vscode.window.tabGroups.all) {
        group.tabs.forEach((tab, index) => {
            placements.push({ viewColumn: group.viewColumn, index, key: tabKey(tab) });
        });
    }
    return placements;
}

async function remember(tabs?: TabPlacement[]): Promise<EditorLayout | undefined> {
    const layout = await readLayout();
    if (layout) {
        history.record({ layout, tabs });
    }
    return layout;
}

/**
 * Undoes a `remember()` whose write then failed.
 *
 * Only when that call actually recorded something. A blind pop would throw away
 * an older, legitimate step whenever the read failed and the write failed with
 * it, which are correlated: both go through the same command path.
 */
function forgetIfRecorded(recorded: EditorLayout | undefined): void {
    if (recorded) {
        history.pop();
    }
}

async function evenColumns(): Promise<void> {
    const recorded = await remember();
    floorGuard?.beginHold();
    try {
        await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
    } catch {
        forgetIfRecorded(recorded);
        notify('ColumnKit: could not even out the columns.', 3000);
        return;
    } finally {
        floorGuard?.endHold(UNDO_SETTLE_MS);
    }
}

/** Focuses the group at 1-based grid position `column`. */
async function focusColumn(column: number): Promise<void> {
    // focusEditorGroup takes no argument, so walking is the only way. Both of
    // these resolve through findGroup by location, which is grid order, the
    // same order getEditorLayout and moveActiveEditor use.
    await vscode.commands.executeCommand('workbench.action.focusFirstEditorGroup');
    for (let step = 1; step < column; step++) {
        await vscode.commands.executeCommand('workbench.action.focusNextGroup');
    }
}

/** Cycles the focused group until `key` is its active tab. */
async function activateTab(key: string): Promise<boolean> {
    const total = vscode.window.tabGroups.activeTabGroup.tabs.length;
    for (let step = 0; step < total; step++) {
        const active = vscode.window.tabGroups.activeTabGroup.activeTab;
        if (active && tabKey(active) === key) {
            return true;
        }
        await vscode.commands.executeCommand('workbench.action.nextEditorInGroup');
    }
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    return active !== undefined && tabKey(active) === key;
}

/**
 * Puts merged tabs back in the columns they came from.
 *
 * Restoring geometry alone recreates the empty columns but leaves every merged
 * tab piled in the group `applyLayout` moved it to, which is the arrangement the
 * user is asking to get back. There is no tab-moving API, so this drives
 * `moveActiveEditor`, whose `by: 'group'` branch indexes
 * `getGroups(GRID_APPEARANCE)`, the same ordering the layout uses.
 *
 * Returns how many tabs could not be put back.
 */
async function restoreTabs(placements: TabPlacement[], columns: number): Promise<number> {
    const locate = (key: string): vscode.TabGroup | undefined =>
        vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tabKey(tab) === key));

    let stranded = 0;
    // Ascending column then index, so tabs arrive in the order they sat in and
    // a column's contents end up in their original sequence.
    const ordered = [...placements].sort(
        (a, b) => a.viewColumn - b.viewColumn || a.index - b.index
    );

    for (const placement of ordered) {
        if (placement.viewColumn < 1 || placement.viewColumn > columns) {
            // The recorded grid no longer exists, so there is nowhere to aim.
            stranded++;
            continue;
        }
        const group = locate(placement.key);
        if (!group) {
            // Closed since the snapshot. Not an error, just nothing to move.
            continue;
        }
        if (group.viewColumn === placement.viewColumn) {
            continue;
        }
        await focusColumn(group.viewColumn);
        if (!(await activateTab(placement.key))) {
            stranded++;
            continue;
        }
        await vscode.commands.executeCommand('moveActiveEditor', {
            to: 'position',
            by: 'group',
            value: placement.viewColumn
        });
    }
    return stranded;
}

async function undoLayout(): Promise<void> {
    const previous = history.pop();
    if (!previous) {
        notify('ColumnKit: nothing to undo.', 3000);
        return;
    }
    // The restored geometry is the user's own, and it may legitimately hold a
    // group on the floor. Stand the guard down for the whole restore, or its
    // correction would undo the undo. Held rather than timed, because moving
    // tabs back can outlast any deadline.
    floorGuard?.beginHold();
    try {
        try {
            await vscode.commands.executeCommand('vscode.setEditorLayout', previous.layout);
        } catch {
            // The entry was already off the ring. Put it back rather than losing
            // a step to a write that never landed, and do not claim a restore.
            history.record(previous);
            notify('ColumnKit: could not restore the layout.', 3000);
            return;
        }

        let stranded = 0;
        if (previous.tabs) {
            const columns = leaves(previous.layout.groups).length;
            try {
                stranded = await restoreTabs(previous.tabs, columns);
            } catch {
                // A failed move must not cost the geometry that already landed.
                stranded = previous.tabs.length;
            }
            log?.trace(`undo moved tabs back into ${columns} columns, ${stranded} stranded`);
        }

        notify(
            stranded === 0
                ? 'ColumnKit: layout restored.'
                : `ColumnKit: layout restored, but ${stranded} tab${stranded === 1 ? '' : 's'} could not be moved back.`,
            3000
        );
    } finally {
        // The tail covers the events the writes produce, which arrive after the
        // commands that caused them have resolved.
        floorGuard?.endHold(UNDO_SETTLE_MS);
    }
}

async function setColumns(columns: number): Promise<void> {
    // One read serves the undo ring, the width measurement and the before-count.
    const previous = await readLayout();
    // Counted from the layout rather than from tabGroups.all, which spans every
    // editor part including auxiliary windows while setEditorLayout only ever
    // writes to the active one.
    const before = previous ? leaves(previous.groups).length : currentColumnCount();

    // Asking for more columns than fit puts every one of them on the floor, and
    // correctFloor cannot rescue that: with nothing above the floor there is no
    // donor to take space from. The preset buttons could create exactly the
    // state this extension exists to prevent, so cap the request instead.
    const fits = maxColumns(
        previous && measureEditorWidth(previous, DEFAULT_FLOOR),
        currentFloors(previous),
        DEFAULT_FLOOR
    );
    const capped = fits !== undefined && columns > fits;
    const wanted = capped ? fits : columns;

    // Only a reduction merges tabs into another group, so only a reduction
    // needs their placement remembered. Recording it on every change would also
    // drag a tab the user moved by hand back on the next undo.
    if (previous) {
        history.record({ layout: previous, tabs: wanted < before ? snapshotTabs() : undefined });
    }

    const size = 1 / wanted;
    const layout: EditorGroupLayout = {
        orientation: 0,
        groups: Array.from({ length: wanted }, () => ({ size }))
    };

    // Hold the guard off across the write. Both paths read the layout and then
    // write a new one, and a correction landing in that gap would be computed
    // from the group count we are in the middle of replacing.
    floorGuard?.beginHold();
    let applied: EditorLayout | undefined;
    try {
        try {
            await vscode.commands.executeCommand('vscode.setEditorLayout', layout);
        } catch {
            // Nothing changed, so the entry recorded above would be a phantom step.
            forgetIfRecorded(previous);
            notify('ColumnKit: could not change the column count.', 3000);
            return;
        }

        // Report what the editor actually did, not what was asked for. A merge
        // can be refused and a count can come back different; describing the
        // request would make the message a guess.
        applied = await readLayout();
    } finally {
        floorGuard?.endHold(UNDO_SETTLE_MS);
    }
    const after = applied ? leaves(applied.groups).length : wanted;
    log?.trace(`column count ${before} -> ${after} (requested ${columns}, wrote ${wanted})`);

    notify(
        describeColumnChange({
            columns: after,
            before,
            floorRisk: assessFloorRisk(previous, after),
            requested: capped ? columns : undefined
        })
    );
}

async function pickColumns(): Promise<void> {
    // From the layout, not tabGroups.all: the picker describes what a write
    // would do, and a write only ever touches the active editor part.
    const layout = await readLayout();
    const current = layout ? leaves(layout.groups).length : currentColumnCount();
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

    /** Operations in progress that must not be corrected part-way through. */
    private holds = 0;

    /**
     * Holds corrections off for the whole of an operation, however long it
     * takes.
     *
     * A deadline alone is a bet that the operation finishes inside it. Undo now
     * writes the geometry and then moves tabs back, and once that ran past the
     * window a correction landed on the layout the user had just restored. The
     * count covers the operation and the deadline covers the events it leaves
     * behind, which arrive after it returns.
     */
    beginHold(): void {
        this.holds++;
    }

    /** Ends one hold and leaves `ms` of tail for the events the write produced. */
    endHold(ms: number): void {
        this.holds = Math.max(0, this.holds - 1);
        this.suspendFor(ms);
    }

    /** Holds corrections off while a deliberate layout write settles. */
    suspendFor(ms: number): void {
        this.suspendedUntil = Date.now() + ms;
    }

    /** Ends a suspension early. The window is global, so tests must clear it. */
    resume(): void {
        this.holds = 0;
        this.suspendedUntil = 0;
    }

    private get suspended(): boolean {
        return this.holds > 0 || Date.now() < this.suspendedUntil;
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
        // A hold has no deadline to wait out, so poll at the debounce interval
        // until it lifts. correctOnce re-schedules while it is still held.
        const held = this.holds > 0 ? 0 : Math.max(0, this.suspendedUntil - Date.now());
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
            if (!config().get<boolean>('autoCorrect', true)) {
                return false;
            }
            if (this.suspended) {
                // The deadline moved after this run was scheduled, because every
                // command re-suspends once its write lands. Returning here would
                // discard the only notification of the change, so re-arm instead.
                this.schedule();
                return false;
            }
            const layout = await readLayout();
            if (!layout || this.disposed) {
                return false;
            }

            // A nested grid mixes widths and heights in one size list, and a flat
            // write would collapse it. Leaf count always equals group count, so
            // only the shape can tell us; bail rather than guess.
            // Orientation 1 stacks rows, so the leaf sizes are heights and the
            // trigger for them is minimumHeight (70), not the width floor. isFlat
            // is true for a flat vertical stack, so it alone is not enough:
            // correcting those against 220 silently undoes the user's sash drag.
            if (layout.orientation !== 0) {
                return false;
            }
            if (!isFlat(layout.groups) || layout.groups.length < 2) {
                return false;
            }

            const sizes = layout.groups.map(n => n.size ?? 0);
            const floors = floorsForColumns(sizes);

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
            log?.trace(
                `raised ${correction.corrected.length} of ${sizes.length} columns off the floor: ` +
                `${JSON.stringify(sizes)} -> ${JSON.stringify(correction.sizes)} ` +
                `(floors ${JSON.stringify(floors)})`
            );
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
    log: vscode.LogOutputChannel;
    /** The message notify() last sent and where it sent it. */
    lastNotification(): { message: string; channel: NotifyChannel } | undefined;
    /** How long activate() took, in milliseconds. Reported in the log. */
    activationMs: number;
    /** Update requests actually issued, so a test can prove none were. */
    updateRequests(): number;
    /** Runs the update check now. The fetch is injectable so no test hits GitHub. */
    checkForUpdate(now?: number, fetch?: FetchRelease): Promise<void>;
    /** Runs the download-and-verify step. Exposed so the checksum gate is testable. */
    installUpdate(update: UpdateDecision, download?: DownloadBytes): Promise<void>;
    /** Extension subscription count. Exposed so the tests can watch for leaks. */
    subscriptionCount(): number;
}

export function activate(context: vscode.ExtensionContext): ColumnKitApi {
    const started = Date.now();

    log = vscode.window.createOutputChannel('ColumnKit', { log: true });
    context.subscriptions.push(log);

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
    // Fire and forget: nothing the user asked for waits on the network.
    void checkForUpdate(context);

    const activationMs = Date.now() - started;
    log.info(`ColumnKit activated in ${activationMs}ms`);

    return {
        floorGuard: guard,
        history,
        statusBar,
        log,
        activationMs,
        lastNotification: () => lastNotification,
        updateRequests: () => updateRequests,
        checkForUpdate: (now?: number, fetch?: FetchRelease) => checkForUpdate(context, now, fetch),
        installUpdate: (update: UpdateDecision, download?: DownloadBytes) =>
            installUpdate(context, update, download),
        subscriptionCount: () => context.subscriptions.length
    };
}

export function deactivate(): void {
    floorGuard = undefined;
    log = undefined;
    lastNotification = undefined;
    // Module state outlives the extension host's activation, so a second
    // activation would otherwise inherit the previous session's undo stack.
    history.clear();
    // Status bar items are disposed through the extension subscriptions.
}
