import * as vscode from 'vscode';
import {
    DEFAULT_FLOOR,
    DEFAULT_HEIGHT_FLOOR,
    EditorLayout,
    LayoutHistory,
    ColumnFloor,
    SETTINGS_FLOOR,
    TabPlacement,
    BalanceMode,
    LayoutNode,
    RememberedLayout,
    balance,
    canRestore,
    decodeLayout,
    encodeLayout,
    correctFloor,
    evenSplit,
    floorRisk,
    isFlat,
    leafSpans,
    leaves,
    maxColumns,
    measureEditorWidth,
    RemainderStrategy,
    splitDepth,
    splitHolding,
    splitIsWidths,
    withPinnedWidths,
    withColumnShare
} from './layout';
import { ASSET_PREFIX, Release, UpdateDecision, decide, isRelease, shouldCheck } from './update';

const CONFIG_SECTION = 'columnkit';

/** Coalesces the burst of activation events VS Code fires when focus moves. */
const AUTO_CORRECT_DEBOUNCE_MS = 120;

/** How often the opt-in idle watch looks, when it is on at all. */
const POLL_INTERVAL_MS = 2000;

/**
 * How long the floor guard stands down after a deliberate layout write.
 *
 * The tail on every hold, not just undo's. It has to outlast the debounce,
 * because the tab-group event a write produces arrives after the write itself
 * has resolved.
 */
const WRITE_SETTLE_MS = 400;

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
function floorForTab(tab: vscode.Tab | undefined, size: number | undefined): ColumnFloor {
    if (tab && tab.input === undefined) {
        return {
            // Undefined where the size is not a width, which is every group
            // inside a stacked branch. Nothing can be concluded from a height,
            // so the arming width falls back to the ordinary one.
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
function floorsForColumns(sizes: number[]): ColumnFloor[] | undefined {
    return floorsForNodes(sizes.map(size => ({ size })));
}

/**
 * A floor pair per top-level node, which is per column even on a 2D grid, or
 * undefined when the groups cannot be matched to the layout at all.
 *
 * A column holding a stack of rows takes the widest floor of anything in that
 * stack: the column has to be wide enough for all of them. Groups inside a
 * stack are matched to tabs by leaf order, because `viewColumn` numbers the
 * grid in exactly that order.
 *
 * `getEditorLayout` reports the ACTIVE editor part while `tabGroups.all` spans
 * every part, so with a floating editor window open the two disagree and there
 * is no sound mapping between them. Assuming the ordinary floor there is not
 * the safe answer, it is the dangerous one: a Settings column at 700 then looks
 * like a donor with 456px to spare, and taking that space gets clamped straight
 * back to exactly 500, which is the width that arms the expand. The guard would
 * be creating the bug it exists to prevent, so it declines instead.
 */
function floorsForNodes(nodes: LayoutNode[]): ColumnFloor[] | undefined {
    const ordinary = () => ({ floor: DEFAULT_FLOOR, donorFloor: DEFAULT_FLOOR });
    const spans = leafSpans(nodes);
    const total = spans.reduce((a, b) => a + b, 0);
    const groups = vscode.window.tabGroups.all;
    if (groups.length !== total) {
        return undefined;
    }
    const byColumn = new Map<number, vscode.TabGroup>();
    for (const group of groups) {
        byColumn.set(group.viewColumn, group);
    }

    let leaf = 0;
    return nodes.map((node, i) => {
        const combined = ordinary();
        for (let under = 0; under < spans[i]; under++) {
            // Under orientation 0 a top-level node's size is a width whether it
            // holds one group or a stack, and every group in that stack shares
            // it. So the same width answers for all of them: a Settings pane in
            // a column sitting at exactly 500 is armed wherever in the stack it
            // is. Passing undefined here made the guard blind to that on every
            // 2D grid.
            const floor = floorForTab(byColumn.get(leaf + 1)?.activeTab, node.size);
            combined.floor = Math.max(combined.floor, floor.floor);
            combined.donorFloor = Math.max(combined.donorFloor, floor.donorFloor);
            leaf++;
        }
        return combined;
    });
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
    // An empty list is the honest answer when the panes cannot be identified:
    // requiredWidth then pays the ordinary floor for every column, which is the
    // right default for sizing a request. Nothing is resized on this path.
    return floorsForColumns(sizes)?.map(f => f.floor) ?? [];
}

/** User-initiated layout changes only. Floor corrections never land here. */
const history = new LayoutHistory();

/** Per workspace, never global: a geometry only means something in context. */
const REMEMBERED_KEY = 'layout.remembered';

/**
 * Pinned widths, keyed by grid position.
 *
 * There is no stable identity for an editor group in the extension API, so a
 * pin belongs to a position rather than to whatever is showing there. That
 * matches Vim, where `winfixwidth` is a window property and is not copied to a
 * split. Kept in workspaceState so pins survive a reload.
 */
const PINS_KEY = 'layout.pins';

function readPins(context: vscode.ExtensionContext): Record<string, number> {
    return context.workspaceState.get<Record<string, number>>(PINS_KEY) ?? {};
}

/** Pins as a per-column list, aligned to the layout. */
function pinsForColumns(context: vscode.ExtensionContext, columns: number): (number | undefined)[] {
    const pins = readPins(context);
    return Array.from({ length: columns }, (_, i) => pins[String(i + 1)]);
}

/** Toggles the pin on the active column, at whatever width it has now. */
async function togglePin(context: vscode.ExtensionContext): Promise<void> {
    const layout = await readLayout();
    const sizes = layout ? layout.groups.map(node => node.size ?? 0) : [];
    if (!layout || layout.orientation !== 0 || !isFlat(layout.groups) || sizes.length < 2) {
        notify(vscode.l10n.t('ColumnKit: pinning needs a flat row of two or more columns.'), 4000);
        return;
    }
    const index = activeColumnIndex(sizes.length);
    if (index === undefined) {
        notify(vscode.l10n.t('ColumnKit: could not tell which column is active.'), 4000);
        return;
    }

    const pins = readPins(context);
    const key = String(index + 1);
    if (pins[key] !== undefined) {
        delete pins[key];
        await context.workspaceState.update(PINS_KEY, pins);
        notify(vscode.l10n.t('ColumnKit: column {0} is no longer pinned.', index + 1), 3000);
        return;
    }

    // Every column pinned leaves nothing to absorb a change, so the last free
    // column stays free.
    const free = sizes.filter((_, i) => pins[String(i + 1)] === undefined).length;
    if (free <= 1) {
        notify(
            vscode.l10n.t('ColumnKit: at least one column has to stay unpinned to take up the slack.'),
            5000
        );
        return;
    }

    pins[key] = sizes[index];
    await context.workspaceState.update(PINS_KEY, pins);
    notify(
        vscode.l10n.t('ColumnKit: column {0} is pinned at {1}px.', index + 1, sizes[index]),
        3000
    );
}

/**
 * Puts the pinned columns back at their width, evening the rest.
 *
 * Runs when the group set changes, which is when a new editor group would
 * otherwise take space from a pinned column.
 */
function pinnedLayoutFor(
    context: vscode.ExtensionContext,
    layout: EditorLayout
): number[] | undefined {
    if (Object.keys(readPins(context)).length === 0) {
        return undefined;
    }
    if (layout.orientation !== 0 || !isFlat(layout.groups)) {
        return undefined;
    }
    const sizes = layout.groups.map(node => node.size ?? 0);
    // Raw weights from a write that has not laid out yet are not a measurement.
    if (sizes.length < 2 || sizes.some(size => size < DEFAULT_FLOOR)) {
        return undefined;
    }
    const floors = floorsForColumns(sizes);
    if (!floors) {
        return undefined;
    }
    return withPinnedWidths(
        sizes,
        pinsForColumns(context, sizes.length),
        floors.map(floor => floor.floor)
    );
}

async function enforcePins(context: vscode.ExtensionContext): Promise<boolean> {
    const layout = await readLayout();
    if (!layout) {
        return false;
    }
    const sizes = layout.groups.map(node => node.size ?? 0);
    const next = pinnedLayoutFor(context, layout);
    if (!next || next.every((size, i) => size === sizes[i])) {
        return false;
    }

    floorGuard?.beginHold();
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: next.map(size => ({ size }))
        });
        log?.trace(`pins applied: ${JSON.stringify(sizes)} -> ${JSON.stringify(next)}`);
        return true;
    } catch {
        return false;
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
    }
}

/** Coalesces the burst of changes a single user action produces. */
const REMEMBER_DEBOUNCE_MS = 1500;
let rememberTimer: NodeJS.Timeout | undefined;

/**
 * Saves the current geometry against the width it was measured at.
 *
 * Off unless asked for. VS Code restores the editor grid itself in most cases,
 * so writing a layout at startup by default would be fighting it for no reason.
 */
async function rememberLayout(context: vscode.ExtensionContext): Promise<void> {
    if (!config().get<boolean>('rememberLayout', false)) {
        return;
    }
    const layout = await readLayout();
    const width = layout && measureEditorWidth(layout, DEFAULT_FLOOR);
    if (!layout || width === undefined) {
        return;
    }
    const remembered: RememberedLayout = {
        width,
        leafCount: leaves(layout.groups).length,
        layout
    };
    await context.workspaceState.update(REMEMBERED_KEY, remembered);
    log?.trace(`remembered ${remembered.leafCount} groups at ${width}px`);
}

function scheduleRemember(context: vscode.ExtensionContext): void {
    if (rememberTimer) {
        clearTimeout(rememberTimer);
    }
    rememberTimer = setTimeout(() => void rememberLayout(context), REMEMBER_DEBOUNCE_MS);
}

/** Puts a remembered geometry back, if it still describes this window. */
async function restoreRememberedLayout(context: vscode.ExtensionContext): Promise<boolean> {
    if (!config().get<boolean>('rememberLayout', false)) {
        return false;
    }
    const saved = context.workspaceState.get<RememberedLayout>(REMEMBERED_KEY);
    const current = await readLayout();
    const width = current && measureEditorWidth(current, DEFAULT_FLOOR);
    if (!current || !canRestore(saved, width, leaves(current.groups).length)) {
        log?.debug('nothing to restore, or it was saved for a different window');
        return false;
    }

    floorGuard?.beginHold();
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', saved!.layout);
        log?.info(`restored the remembered layout for this workspace`);
        return true;
    } catch {
        return false;
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
    }
}

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
                    // Runs in the response callback, not the executor, so a
                    // malformed Location would throw where nothing can catch it
                    // and this promise would never settle.
                    let next: string;
                    try {
                        next = new URL(location, url).toString();
                    } catch {
                        resolve(undefined);
                        return;
                    }
                    resolve(httpsGet(next, limit, redirectsLeft - 1));
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
    // Checked again here, not only where the decision was built. This function
    // is on the exported API, so it can be reached with a decision this
    // extension never made.
    if (!asset.url.startsWith(ASSET_PREFIX)) {
        log?.warn(`update rejected: ${asset.url} is not a ColumnKit release asset`);
        notify(
            vscode.l10n.t('ColumnKit: that update did not come from the ColumnKit releases page.'),
            6000
        );
        return;
    }
    const bytes = await download(asset.url, MAX_VSIX_BYTES);
    if (!bytes) {
        notify(vscode.l10n.t('ColumnKit: the update could not be downloaded.'), 4000);
        return;
    }
    const crypto = await import('node:crypto');
    const actual = crypto.createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.sha256) {
        log?.warn(`update rejected: expected ${asset.sha256}, got ${actual}`);
        notify(
            vscode.l10n.t(
                'ColumnKit: the downloaded update did not match its checksum, so it was not installed.'
            ),
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
    // Nothing to do in a browser: vscode.dev installs from the Marketplace and
    // updates on its own, there is no .vsix to sideload, and the download path
    // below is Node's https and crypto, which a web worker host does not have.
    if (vscode.env.uiKind === vscode.UIKind.Web) {
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
        const update_ = vscode.l10n.t('Update');
        const notes = vscode.l10n.t('Release notes');
        const skip = vscode.l10n.t('Skip this version');
        const install = update.asset ? update_ : undefined;
        const choice = await vscode.window.showInformationMessage(
            vscode.l10n.t(
                'ColumnKit {0} is available. You have {1}.',
                update.version,
                current
            ),
            ...[install, notes, skip].filter((x): x is string => !!x)
        );

        if (choice === update_) {
            await installUpdate(context, update);
        } else if (choice === notes) {
            await vscode.env.openExternal(vscode.Uri.parse(update.release.html_url));
        } else if (choice === skip) {
            await context.globalState.update(SKIPPED_VERSION_KEY, update.version);
        }
    } catch (error) {
        // Fire and forget from activate(), so an escape here lands as an
        // unhandled rejection in the host log and the promise never settles.
        log?.debug(`update check failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

export interface ColumnChange {
    /** Column count that was requested. */
    columns: number;
    /** Column count before the change. */
    before: number;
    /** Whether the result may leave columns on the minimum-width floor. */
    floorRisk: boolean;
    /** Set only when the request was capped, to the count originally asked for. */
    requested?: number;
}

/**
 * A counted noun, with both forms given to the translator.
 *
 * Building "3 " + "column" + "s" in English and dropping the result into a
 * placeholder leaves every counted sentence half translated, and bakes in a
 * plural rule most languages do not have.
 */
function plural(n: number, one: string, many: string): string {
    return n === 1 ? vscode.l10n.t(one, n) : vscode.l10n.t(many, n);
}

const COLUMNS = ['{0} column', '{0} columns'] as const;
const GROUPS = ['{0} group', '{0} groups'] as const;
const EMPTY_COLUMNS = ['{0} empty column', '{0} empty columns'] as const;

/**
 * One message describing the whole outcome.
 *
 * Two consecutive setStatusBarMessage calls do not queue: the second replaces
 * the first. Reporting the merge and the floor risk separately meant the merge
 * notice was destroyed in exactly the case that carried both.
 *
 * Lives here rather than in layout.ts, which is deliberately free of the vscode
 * module: this is presentation, and it is the one place that needs l10n.
 */
export function describeColumnChange(change: ColumnChange): string {
    const { columns, before, floorRisk, requested } = change;

    if (requested !== undefined && requested !== columns) {
        return vscode.l10n.t(
            'ColumnKit: {0} will not fit above the minimum width, so you have {1}. Any more would put every column at the minimum width, where a click expands it.',
            plural(requested, ...COLUMNS),
            columns
        );
    }

    let outcome: string;
    if (columns < before) {
        outcome = vscode.l10n.t(
            '{0}, {1} merged into the last one. Nothing was closed.',
            plural(columns, ...COLUMNS),
            plural(before - columns, ...COLUMNS)
        );
    } else if (columns > before) {
        outcome = vscode.l10n.t(
            '{0}, {1} added.',
            plural(columns, ...COLUMNS),
            plural(columns - before, ...EMPTY_COLUMNS)
        );
    } else {
        outcome = vscode.l10n.t('{0}, evened.', plural(columns, ...COLUMNS));
    }

    const risk = floorRisk
        ? ' ' + vscode.l10n.t('Columns may sit at the minimum width and expand on click.')
        : '';
    return `ColumnKit: ${outcome}${risk}`;
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

/**
 * Where every open tab sits right now, in grid order.
 *
 * Deduplicated by key. The same resource open in two columns collapses to one
 * editor when the groups merge, so two placements would then compete for one
 * tab: the first would see it already in place and the second would drag it out
 * of the column it was correctly in. Two tabs that share a label and have no
 * resource, a pair of terminals say, are indistinguishable through this API and
 * are treated the same way. First position recorded wins.
 */
function snapshotTabs(): TabPlacement[] {
    const placements: TabPlacement[] = [];
    const seen = new Set<string>();
    for (const group of vscode.window.tabGroups.all) {
        group.tabs.forEach((tab, index) => {
            const key = tabKey(tab);
            if (seen.has(key)) {
                return;
            }
            seen.add(key);
            placements.push({ viewColumn: group.viewColumn, index, key });
        });
    }
    return placements;
}

/** The group currently holding the tab with this key, if any. */
function groupHolding(key: string): vscode.TabGroup | undefined {
    return vscode.window.tabGroups.all.find(group => group.tabs.some(tab => tabKey(tab) === key));
}

/** Whether two layouts have the same leaf widths, in the same order. */
function sameSizes(a: EditorLayout | undefined, b: EditorLayout | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    const left = leaves(a.groups).map(node => node.size ?? 0);
    const right = leaves(b.groups).map(node => node.size ?? 0);
    return left.length === right.length && left.every((size, i) => size === right[i]);
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

async function evenColumns(context: vscode.ExtensionContext): Promise<void> {
    const previous = await readLayout();
    // A pinned column keeps its width while the rest are evened, which the
    // built-in command cannot do: it distributes every group in the grid.
    const pinned = previous ? pinnedLayoutFor(context, previous) : undefined;
    // On a grid there are two defensible answers and the built-in only gives
    // one, so the setting decides. On a flat row they agree, and the built-in
    // is the better-tested path.
    const balanced =
        !pinned && previous && !isFlat(previous.groups)
            ? balance(
                previous,
                config().get<BalanceMode>('balanceMode', 'tree') === 'area' ? 'area' : 'tree'
            )
            : undefined;
    floorGuard?.beginHold();
    try {
        if (pinned) {
            await vscode.commands.executeCommand('vscode.setEditorLayout', {
                orientation: 0,
                groups: pinned.map(size => ({ size }))
            });
        } else if (balanced) {
            await vscode.commands.executeCommand('vscode.setEditorLayout', balanced);
        } else {
            await vscode.commands.executeCommand('workbench.action.evenEditorWidths');
        }
    } catch {
        notify(vscode.l10n.t('ColumnKit: could not even out the columns.'), 3000);
        return;
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
    }

    const applied = await readLayout();
    const columns = applied ? leaves(applied.groups).length : currentColumnCount();

    // Recorded after the fact, and only when something moved. Even on an
    // already-even layout would otherwise push a step that undoes to the same
    // widths while announcing a restore.
    if (previous && !sameSizes(previous, applied)) {
        history.record({ layout: previous });
    }

    // evenEditorWidths raises no tab or group event at all, so without this
    // nothing ever asks the guard to look at what it just produced. Evening
    // more columns than fit puts every one of them on the floor.
    floorGuard?.schedule();

    // Even was the one action that said nothing, which made the primary button
    // the only one with no confirmation, and it never warned about the floor.
    notify(
        describeColumnChange({
            columns,
            before: columns,
            floorRisk: assessFloorRisk(applied, columns)
        })
    );
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
        const group = groupHolding(placement.key);
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
        // moveActiveEditor indexes the group list and does nothing at all when
        // the index is past the end, so the move has to be confirmed rather
        // than assumed. Reporting a restore that silently did not happen is
        // worse than reporting a stranded tab.
        const landed = groupHolding(placement.key);
        if (!landed || landed.viewColumn !== placement.viewColumn) {
            stranded++;
        }
    }
    return stranded;
}

/**
 * Runs `restore` with VS Code's close-empty-group behaviour switched off.
 *
 * Moving the last editor out of a group deletes that group:
 * `doCloseActiveEditor` ends with `closeEmptyGroups && removeGroup(this)`, and
 * that setting defaults to true. A reduction whose merge target had no tabs of
 * its own therefore collapses the restored grid the moment the merged tab is
 * moved back, and the user gets fewer columns than they started with. Held off
 * for the duration and put back exactly as it was found, including removing the
 * key again when it was never set.
 */
async function keepingEmptyGroups<T>(restore: () => Promise<T>): Promise<T> {
    const editor = () => vscode.workspace.getConfiguration('workbench.editor');
    const previous = editor().inspect<boolean>('closeEmptyGroups')?.globalValue;
    await editor().update('closeEmptyGroups', false, vscode.ConfigurationTarget.Global);
    try {
        return await restore();
    } finally {
        await editor().update('closeEmptyGroups', previous, vscode.ConfigurationTarget.Global);
    }
}

/**
 * Evens only the split the active group belongs to.
 *
 * On a flat row that is the same thing as Even. On a grid it is not: evening
 * one column's rows should leave the column beside it exactly as it was.
 */
/** Whether every member of the split holding `leafIndex` clears `floor`. */
function clearsFloor(layout: EditorLayout, leafIndex: number, floor: number): boolean {
    const siblings = splitHolding(layout.groups, leafIndex);
    return siblings !== undefined && siblings.every(node => (node.size ?? 0) > floor);
}

async function evenSplitHere(): Promise<void> {
    const layout = await readLayout();
    if (!layout) {
        notify(vscode.l10n.t('ColumnKit: could not read the layout.'), 3000);
        return;
    }
    const total = leaves(layout.groups).length;
    const leafIndex = activeColumnIndex(total);
    if (leafIndex === undefined) {
        notify(vscode.l10n.t('ColumnKit: could not tell which group is active.'), 4000);
        return;
    }

    // A layout that has not been laid out yet still reports the raw weights it
    // was written with, and evening arithmetic on those is arithmetic on
    // nothing.
    if (leaves(layout.groups).some(node => (node.size ?? 0) < 1)) {
        notify(vscode.l10n.t('ColumnKit: the columns have not settled yet, try again.'), 3000);
        return;
    }

    const next = evenSplit(layout, leafIndex);
    if (!next) {
        notify(vscode.l10n.t('ColumnKit: this group has nothing to even out against.'), 4000);
        return;
    }

    // Which axis this split runs along decides which minimum applies, and that
    // alternates with depth rather than following the top-level orientation.
    // doRestoreGroup expands on the height matching minimumHeight just as
    // readily as on the width, so both have to be checked.
    const depth = splitDepth(layout.groups, leafIndex);
    if (depth === undefined) {
        notify(vscode.l10n.t('ColumnKit: this group has nothing to even out against.'), 4000);
        return;
    }
    const widths = splitIsWidths(layout.orientation, depth);

    if (widths && depth === 0) {
        // Only the top level maps onto the tab groups, so only there can the
        // real per-pane minimums be read.
        const floors = floorsForNodes(next.groups);
        if (!floors || next.groups.some((node, i) => (node.size ?? 0) <= floors[i].floor)) {
            notify(
                vscode.l10n.t(
                    'ColumnKit: evening these would put a column at the minimum width, where a click expands it.'
                ),
                5000
            );
            return;
        }
    } else if (!clearsFloor(next, leafIndex, widths ? DEFAULT_FLOOR : DEFAULT_HEIGHT_FLOOR)) {
        notify(
            widths
                ? vscode.l10n.t(
                    'ColumnKit: evening these would put a column at the minimum width, where a click expands it.'
                )
                : vscode.l10n.t(
                    'ColumnKit: evening these would put a row at the minimum height, where a click expands it.'
                ),
            5000
        );
        return;
    }

    history.record({ layout });
    floorGuard?.beginHold();
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', next);
    } catch {
        history.pop();
        notify(vscode.l10n.t('ColumnKit: could not even out this split.'), 3000);
        return;
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
    }
    notify(vscode.l10n.t('ColumnKit: this split is evened.'), 3000);
}

async function copyLayout(): Promise<void> {
    const layout = await readLayout();
    const text = layout && encodeLayout(layout);
    if (!text) {
        notify(vscode.l10n.t('ColumnKit: the columns have not settled yet, try again.'), 3000);
        return;
    }
    await vscode.env.clipboard.writeText(text);
    notify(vscode.l10n.t('ColumnKit: layout copied to the clipboard.'), 3000);
}

/**
 * Applies a layout string from the clipboard.
 *
 * Refuses a group count that does not match what is open. Applying one with
 * more groups would silently add empty columns, and one with fewer would merge
 * editors into another column, neither of which is what someone pasting a
 * geometry is asking for.
 */
async function pasteLayout(): Promise<void> {
    const text = await vscode.env.clipboard.readText();
    const incoming = decodeLayout(text);
    if (!incoming) {
        notify(
            vscode.l10n.t('ColumnKit: the clipboard does not hold a ColumnKit layout, or it was damaged in transit.'),
            5000
        );
        return;
    }

    const current = await readLayout();
    const open = current ? leaves(current.groups).length : currentColumnCount();
    const wanted = leaves(incoming.groups).length;
    if (wanted !== open) {
        notify(
            vscode.l10n.t(
                'ColumnKit: that layout is for {0}, and you have {1} open.',
                plural(wanted, ...GROUPS),
                open
            ),
            6000
        );
        return;
    }

    if (current) {
        history.record({ layout: current });
    }
    floorGuard?.beginHold();
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', incoming);
    } catch {
        history.pop();
        notify(vscode.l10n.t('ColumnKit: could not apply that layout.'), 3000);
        return;
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
    }
    notify(vscode.l10n.t('ColumnKit: layout applied.'), 3000);
}

async function undoLayout(): Promise<void> {
    const previous = history.pop();
    if (!previous) {
        notify(vscode.l10n.t('ColumnKit: nothing to undo.'), 3000);
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
            notify(vscode.l10n.t('ColumnKit: could not restore the layout.'), 3000);
            return;
        }

        let stranded = 0;
        const tabs = previous.tabs;
        // Only when something is actually out of place. Otherwise every undo
        // would write a user setting twice for nothing, which every other
        // extension in the window hears about.
        const displaced =
            tabs?.some(placement => {
                const group = groupHolding(placement.key);
                return group !== undefined && group.viewColumn !== placement.viewColumn;
            }) ?? false;
        if (tabs && displaced) {
            const columns = leaves(previous.layout.groups).length;
            try {
                stranded = await keepingEmptyGroups(() => restoreTabs(tabs, columns));
            } catch {
                // A failed move must not cost the geometry that already landed.
                stranded = tabs.length;
            }
            log?.trace(`undo moved tabs back into ${columns} columns, ${stranded} stranded`);
        }

        notify(
            stranded === 0
                ? vscode.l10n.t('ColumnKit: layout restored.')
                : vscode.l10n.t(
                    'ColumnKit: layout restored, but {0} could not be moved back.',
                    plural(stranded, '{0} tab', '{0} tabs')
                ),
            3000
        );
    } finally {
        // The tail covers the events the writes produce, which arrive after the
        // commands that caused them have resolved.
        floorGuard?.endHold(WRITE_SETTLE_MS);
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
        // Placement is recorded only for a reduction, which is the only change
        // that merges, and only when every tab group belongs to the editor part
        // this write will touch. `tabGroups.all` spans auxiliary windows while
        // the layout describes the active part alone, so with a floating window
        // open the two disagree and there is no sound mapping between them.
        const mappable = vscode.window.tabGroups.all.length === before;
        history.record({
            layout: previous,
            tabs: wanted < before && mappable ? snapshotTabs() : undefined
        });
    }

    const size = 1 / wanted;
    const layout: EditorLayout = {
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
            notify(vscode.l10n.t('ColumnKit: could not change the column count.'), 3000);
            return;
        }

        // Report what the editor actually did, not what was asked for. A merge
        // can be refused and a count can come back different; describing the
        // request would make the message a guess.
        applied = await readLayout();
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
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

/** Shares offered for the active column. Round numbers people actually mean. */
const SHARE_PRESETS = [25, 33, 40, 50, 60, 67, 75];

/**
 * The active group's position in the grid, or undefined when it cannot be
 * placed.
 *
 * `tabGroups` spans every editor part while the layout describes the active one
 * alone, so a mismatch means the active group may not even be in the grid this
 * would write to.
 */
function activeColumnIndex(columns: number): number | undefined {
    if (vscode.window.tabGroups.all.length !== columns) {
        return undefined;
    }
    const index = vscode.window.tabGroups.activeTabGroup.viewColumn - 1;
    return index >= 0 && index < columns ? index : undefined;
}

/**
 * Gives the active column a share of the editor area.
 *
 * A count is often not what someone means. "Make this one half the width" is,
 * and there is no way to say it otherwise.
 */
async function setColumnShare(percent: number): Promise<void> {
    const layout = await readLayout();
    const sizes = layout ? leaves(layout.groups).map(node => node.size ?? 0) : [];
    if (!layout || !isFlat(layout.groups) || layout.orientation !== 0 || sizes.length < 2) {
        notify(vscode.l10n.t('ColumnKit: this needs a flat row of two or more columns.'), 4000);
        return;
    }
    if (sizes.some(size => size < DEFAULT_FLOOR)) {
        // Raw weights from a write that has not laid out yet, not a measurement.
        notify(vscode.l10n.t('ColumnKit: the columns have not settled yet, try again.'), 3000);
        return;
    }
    const index = activeColumnIndex(sizes.length);
    if (index === undefined) {
        notify(vscode.l10n.t('ColumnKit: could not tell which column is active.'), 4000);
        return;
    }

    const strategy = config().get<RemainderStrategy>('remainderStrategy', 'even');
    const shareFloors = floorsForColumns(sizes);
    const next = shareFloors
        ? withColumnShare(
            sizes,
            index,
            percent,
            strategy === 'proportional' ? 'proportional' : 'even',
            shareFloors.map(floor => floor.floor)
        )
        : undefined;
    if (!next) {
        notify(
            vscode.l10n.t(
                'ColumnKit: {0}% would put a column at the minimum width, where a click expands it.',
                percent
            ),
            5000
        );
        return;
    }

    history.record({ layout });
    floorGuard?.beginHold();
    try {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: next.map(size => ({ size }))
        });
    } catch {
        history.pop();
        notify(vscode.l10n.t('ColumnKit: could not resize the columns.'), 3000);
        return;
    } finally {
        floorGuard?.endHold(WRITE_SETTLE_MS);
    }

    log?.trace(`column ${index + 1} to ${percent}% (${strategy}): ${JSON.stringify(next)}`);
    notify(
        vscode.l10n.t(
            'ColumnKit: column {0} is now {1}% of the width.',
            index + 1,
            Math.round((next[index] / next.reduce((a, b) => a + b, 0)) * 100)
        )
    );
}

/**
 * Asks for a share, or applies one given directly.
 *
 * The argument makes the command usable from a keybinding or another extension
 * without going through the picker, and is how the tests drive it.
 */
async function pickColumnWidth(percent?: number): Promise<void> {
    if (typeof percent === 'number') {
        await setColumnShare(percent);
        return;
    }

    const items: (vscode.QuickPickItem & { percent?: number })[] = SHARE_PRESETS.map(percent => ({
        label: `${percent}%`,
        percent
    }));
    const CUSTOM = vscode.l10n.t('Custom...');
    items.push({ label: CUSTOM });

    const choice = await vscode.window.showQuickPick(items, {
        title: 'ColumnKit',
        placeHolder: vscode.l10n.t('Share of the editor area for the active column')
    });
    if (!choice) {
        return;
    }
    if (choice.percent !== undefined) {
        await setColumnShare(choice.percent);
        return;
    }

    const typed = await vscode.window.showInputBox({
        title: 'ColumnKit',
        prompt: vscode.l10n.t('Share of the editor area for the active column, 1 to 99'),
        validateInput: value => {
            const percent = Number(value);
            return Number.isInteger(percent) && percent > 0 && percent < 100
                ? undefined
                : vscode.l10n.t('Enter a whole number between 1 and 99.');
        }
    });
    if (typed) {
        await setColumnShare(Number(typed));
    }
}

export interface ColumnPickItem extends vscode.QuickPickItem {
    /** The count this item applies, absent on the separator and the undo entry. */
    columns?: number;
    undo?: boolean;
}

/**
 * The picker's contents.
 *
 * Split out so the ordering and the wording can be asserted without driving a
 * quick pick, which needs a person to accept it.
 *
 * `fits` is the largest count that stays clear of the floors, or undefined when
 * the width is unknown. Counts past it are still offered, because the cap and
 * its message still apply if one is chosen, but saying so up front beats letting
 * someone pick 9 and be told afterwards.
 */
export function buildColumnPickItems(
    current: number,
    fits: number | undefined,
    steps: number
): ColumnPickItem[] {
    const items: ColumnPickItem[] = [];
    for (let n = 1; n <= 12; n++) {
        let detail: string;
        if (n === current) {
            detail = vscode.l10n.t('Current layout. Picking this evens the widths.');
        } else if (fits !== undefined && n > fits) {
            detail = vscode.l10n.t('Will not fit above the minimum width in this window.');
        } else if (n < current) {
            detail = vscode.l10n.t('Merges {0} into the last one.', plural(current - n, ...COLUMNS));
        } else {
            detail = vscode.l10n.t('Adds {0}.', plural(n - current, ...EMPTY_COLUMNS));
        }
        items.push({
            label: `${n}`,
            description: n === 1 ? vscode.l10n.t('column') : vscode.l10n.t('columns'),
            detail,
            columns: n
        });
    }

    // Last, and behind a separator. As the first item it was preselected, so
    // opening the picker and pressing Enter undid a layout change instead of
    // choosing a count.
    if (steps > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({
            label: '$(discard) ' + vscode.l10n.t('Undo the last ColumnKit change'),
            description: vscode.l10n.t('{0} available', plural(steps, '{0} step', '{0} steps')),
            undo: true
        });
    }
    return items;
}

async function pickColumns(): Promise<void> {
    // From the layout, not tabGroups.all: the picker describes what a write
    // would do, and a write only ever touches the active editor part.
    const layout = await readLayout();
    const current = layout ? leaves(layout.groups).length : currentColumnCount();
    const fits = maxColumns(
        layout && measureEditorWidth(layout, DEFAULT_FLOOR),
        currentFloors(layout),
        DEFAULT_FLOOR
    );
    const items = buildColumnPickItems(current, fits, history.size);

    // createQuickPick rather than showQuickPick, so the count you already have
    // starts selected instead of whatever happens to be at the top.
    const pick = vscode.window.createQuickPick<ColumnPickItem>();
    let choice: ColumnPickItem | undefined;
    try {
        pick.title = 'ColumnKit';
        pick.placeholder = vscode.l10n.t('Column count (currently {0})', current);
        pick.items = items;
        const active = items.find(item => item.columns === current);
        if (active) {
            pick.activeItems = [active];
        }
        choice = await new Promise<ColumnPickItem | undefined>(resolve => {
            pick.onDidAccept(() => resolve(pick.selectedItems[0]));
            pick.onDidHide(() => resolve(undefined));
            pick.show();
        });
    } finally {
        pick.dispose();
    }

    if (!choice) {
        return;
    }
    if (choice.undo) {
        await undoLayout();
        return;
    }
    if (choice.columns !== undefined) {
        await setColumns(choice.columns);
    }
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
            vscode.l10n.t('Even out every open column, keeping the count as-is.') + '\n\n' +
            [2, 3, 4, 6, 8]
                .map(n => `[${vscode.l10n.t('{0} columns', n)}](command:columnkit.columns${n})`)
                .join(' · ') +
            `\n\n[${vscode.l10n.t('Choose a count...')}](command:columnkit.pickColumns)` +
            ` · [${vscode.l10n.t('Set this column\'s width...')}](command:columnkit.setColumnWidth)` +
            ` · [${vscode.l10n.t('Undo the last ColumnKit change')}](command:columnkit.undoLayout)`
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
            name: vscode.l10n.t('ColumnKit: Even Out Columns'),
            label: vscode.l10n.t('Even out editor columns'),
            tooltip: this.menu(),
            command: 'columnkit.even'
        });

        for (const n of presets) {
            this.add(alignment, priority--, {
                text: `${n}`,
                name: vscode.l10n.t('ColumnKit: {0} Columns', n),
                label: vscode.l10n.t('{0} equal editor {1}', n, n === 1 ? vscode.l10n.t('column') : vscode.l10n.t('columns')),
                tooltip: vscode.l10n.t('ColumnKit: {0} equal columns', n),
                command: `columnkit.columns${n}`
            });
        }

        // Only alongside the numbered buttons. On its own the picker duplicates
        // what the hover menu already offers.
        if (presets.length > 0) {
            this.add(alignment, priority--, {
                text: '$(layout)',
                name: vscode.l10n.t('ColumnKit: Column Count Picker'),
                label: vscode.l10n.t('Choose editor column count'),
                tooltip: vscode.l10n.t('ColumnKit: pick a column count'),
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
    private poll: NodeJS.Timeout | undefined;
    private correcting = false;
    private pending = false;
    private disposed = false;

    /** Corrections applied since activation. Read by the tests. */
    corrections = 0;

    /**
     * Starts or stops the idle watch.
     *
     * Some geometry changes raise no event an extension can observe at all.
     * Measured on 1.136.1: a same-count `setEditorLayout`, evenEditorWidths and
     * toggling the side bar each fired zero tab and zero group events, and a
     * sash drag has never had one. A column dragged onto its minimum stays
     * armed until something unrelated happens. Polling is the only signal left,
     * so it is opt-in, runs only while the window has focus, and each tick is
     * the same read the event path already does.
     */
    setPolling(on: boolean, intervalMs = POLL_INTERVAL_MS): void {
        if (this.poll) {
            clearInterval(this.poll);
            this.poll = undefined;
        }
        if (!on || this.disposed) {
            return;
        }
        this.poll = setInterval(() => void this.run(), intervalMs);
    }

    /** Whether the idle watch is running. Read by the tests. */
    get polling(): boolean {
        return this.poll !== undefined;
    }

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

    /**
     * Ends any suspension and cancels a pass that has not run yet.
     *
     * Both the window and the timer outlive whatever set them, so a test that
     * wants a known starting state has to clear both. Without the cancel, a
     * correction scheduled by the previous write lands at an unpredictable
     * moment and the next assertion is reading a layout something else moved.
     */
    resume(): void {
        this.holds = 0;
        this.suspendedUntil = 0;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = undefined;
        }
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

            // Orientation 1 stacks rows, so the top-level sizes are heights and
            // the trigger for them is minimumHeight (70), not the width floor.
            // Correcting those against 220 would silently undo a sash drag.
            if (layout.orientation !== 0) {
                return false;
            }
            if (layout.groups.length < 2) {
                return false;
            }

            // Top-level nodes only. With orientation 0 each one is a column and
            // its size is a width, whether it holds a single group or a stack of
            // rows, so a 2D grid is corrected without being flattened. The
            // children are carried through the write untouched.
            const nodes = layout.groups;
            const sizes = nodes.map(n => n.size ?? 0);
            const floors = floorsForNodes(nodes);
            if (!floors) {
                // Another editor part is open, so the groups cannot be matched
                // to this grid. Guessing the ordinary floor here is what lets a
                // wide-floored pane be treated as a donor and clamped back onto
                // its minimum by our own write.
                log?.trace('floors unknown, declining to correct');
                return false;
            }

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
                // Spread, so a branch keeps its children and the grid survives.
                groups: nodes.map((node, i) => ({ ...node, size: correction.sizes[i] }))
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
        this.setPolling(false);
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
    /**
     * Whether activate() asked the guard to look at the restored layout. The
     * host cannot be re-activated inside a run, so this is the only way to
     * assert the wiring rather than the behaviour.
     */
    scheduledAtActivation: boolean;
    /** Update requests actually issued, so a test can prove none were. */
    updateRequests(): number;
    /** Runs the update check now. The fetch is injectable so no test hits GitHub. */
    checkForUpdate(now?: number, fetch?: FetchRelease): Promise<void>;
    /** Runs the download-and-verify step. Exposed so the checksum gate is testable. */
    installUpdate(update: UpdateDecision, download?: DownloadBytes): Promise<void>;
    /** Drops every pin. Exposed so a test can leave the workspace as it found it. */
    clearPins(): Promise<void>;
    /** Saves the current geometry for this workspace, bypassing the debounce. */
    rememberLayout(): Promise<void>;
    /** Puts a remembered geometry back. Resolves false when it does not apply. */
    restoreRememberedLayout(): Promise<boolean>;
    /** Extension subscription count. Exposed so the tests can watch for leaks. */
    subscriptionCount(): number;
}

export function activate(context: vscode.ExtensionContext): ColumnKitApi {
    const started = Date.now();

    log = vscode.window.createOutputChannel('ColumnKit', { log: true });
    context.subscriptions.push(log);

    context.subscriptions.push(
        vscode.commands.registerCommand('columnkit.even', () => evenColumns(context)),
        vscode.commands.registerCommand('columnkit.pickColumns', pickColumns),
        vscode.commands.registerCommand('columnkit.undoLayout', undoLayout),
        vscode.commands.registerCommand('columnkit.evenSplit', evenSplitHere),
        vscode.commands.registerCommand('columnkit.copyLayout', copyLayout),
        vscode.commands.registerCommand('columnkit.pasteLayout', pasteLayout),
        vscode.commands.registerCommand('columnkit.pinColumn', () => togglePin(context)),
        vscode.commands.registerCommand('columnkit.setColumnWidth', (percent?: number) =>
            pickColumnWidth(typeof percent === 'number' ? percent : undefined)
        )
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
        vscode.window.tabGroups.onDidChangeTabGroups(() => {
            guard.schedule();
            scheduleRemember(context);
            // A new group takes its space from whatever was there, including a
            // column the user pinned. Putting the pins back is the whole point
            // of having them.
            void enforcePins(context);
        }),
        // Tabs too, not just groups. The floor belongs to the pane a group is
        // showing, and opening one changes that without touching the group set:
        // opening Settings in a 300px column has VS Code clamp it to exactly
        // 500, the arming width, while firing onDidChangeTabs alone.
        vscode.window.tabGroups.onDidChangeTabs(() => guard.schedule())
    );

    // Only while the window has focus: a background window's columns are not
    // being dragged, and a timer in every open window is a cost nobody asked
    // for. Off unless the user turns it on.
    const updatePolling = () => {
        guard.setPolling(
            config().get<boolean>('watchWhileIdle', false) && vscode.window.state.focused
        );
        if (!vscode.window.state.focused) {
            // Leaving the window is the last moment the geometry is worth
            // keeping, and it is the moment a sash drag has certainly finished.
            scheduleRemember(context);
        }
    };
    updatePolling();

    context.subscriptions.push(
        vscode.window.onDidChangeWindowState(() => updatePolling()),
        vscode.workspace.onDidChangeConfiguration(event => {
            if (
                event.affectsConfiguration(`${CONFIG_SECTION}.statusBarPresets`) ||
                event.affectsConfiguration(`${CONFIG_SECTION}.statusBarAlignment`)
            ) {
                statusBar.rebuild();
            }
            if (event.affectsConfiguration(`${CONFIG_SECTION}.watchWhileIdle`)) {
                updatePolling();
            }
        })
    );

    // Before the guard's first pass, so the pass judges what was restored.
    void restoreRememberedLayout(context).then(() => guard.schedule());

    // The grid is restored, and the active group set, before the extension host
    // exists, so no event ever describes the layout we start with. A window
    // reloaded with a column on its floor would stay armed until something else
    // happened to fire one. One pass over the restored layout closes that.
    guard.schedule();
    const scheduledAtActivation = true;

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
        scheduledAtActivation,
        lastNotification: () => lastNotification,
        updateRequests: () => updateRequests,
        checkForUpdate: (now?: number, fetch?: FetchRelease) => checkForUpdate(context, now, fetch),
        installUpdate: (update: UpdateDecision, download?: DownloadBytes) =>
            installUpdate(context, update, download),
        clearPins: () => Promise.resolve(context.workspaceState.update(PINS_KEY, undefined)),
        rememberLayout: () => rememberLayout(context),
        restoreRememberedLayout: () => restoreRememberedLayout(context),
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
