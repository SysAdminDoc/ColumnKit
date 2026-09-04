/**
 * Layout arithmetic, kept free of the vscode module so it can be unit-tested
 * without an Extension Development Host.
 *
 * `vscode.getEditorLayout` returns sizes in CSS pixels, measured 2026-09-03 on
 * VS Code 1.136.1: writing {0.5, 0.3, 0.2} reads back [412, 220, 220]. The write
 * path normalizes arbitrary magnitudes as relative weights, so pixel values read
 * from a layout can be fed straight back into a write.
 */

export interface LayoutNode {
    size?: number;
    groups?: LayoutNode[];
}

export interface EditorLayout {
    orientation: 0 | 1;
    groups: LayoutNode[];
}

/** Depth-first leaf order, which is the order ViewColumn indexes. */
export function leaves(nodes: LayoutNode[], out: LayoutNode[] = []): LayoutNode[] {
    for (const node of nodes) {
        if (node.groups && node.groups.length > 0) {
            leaves(node.groups, out);
        } else {
            out.push(node);
        }
    }
    return out;
}

/**
 * How many leaves sit under each top-level node, in order.
 *
 * A top-level node is a column whatever is inside it: with orientation 0 its
 * `size` is a width even when it holds a stack of rows. Knowing how many groups
 * each one covers is what maps the columns back onto the tab groups, which are
 * numbered across the whole grid in leaf order.
 */
export function leafSpans(nodes: LayoutNode[]): number[] {
    return nodes.map(node => leaves([node]).length);
}

/**
 * The sibling list the leaf at `leafIndex` sits directly in.
 *
 * Returned by reference into `nodes`, so a caller working on a copy can resize
 * exactly that container and leave the rest of the tree alone.
 */
function siblingsOf(nodes: LayoutNode[], leafIndex: number): LayoutNode[] | undefined {
    if (leafIndex < 0) {
        return undefined;
    }
    let seen = 0;
    for (const node of nodes) {
        const span = leaves([node]).length;
        if (leafIndex < seen + span) {
            return node.groups && node.groups.length > 0
                ? siblingsOf(node.groups, leafIndex - seen)
                : nodes;
        }
        seen += span;
    }
    return undefined;
}

/**
 * Equalizes only the split the given group is part of.
 *
 * `workbench.action.evenEditorWidths` distributes every group in the grid,
 * which is too blunt on a 2D layout: evening one column's two rows should not
 * touch the column beside it. Vim has `vertical wincmd =` and tmux has
 * `select-layout -E` for the same reason.
 *
 * Returns a whole new layout, so the caller writes the tree back intact.
 */
export function evenSplit(layout: EditorLayout, leafIndex: number): EditorLayout | undefined {
    const clone = JSON.parse(JSON.stringify(layout)) as EditorLayout;
    const siblings = siblingsOf(clone.groups, leafIndex);
    if (!siblings || siblings.length < 2) {
        return undefined;
    }
    const total = siblings.reduce((sum, node) => sum + (node.size ?? 0), 0);
    const shares = weightedSizes(total, siblings.map(() => 1));
    if (!shares) {
        return undefined;
    }
    siblings.forEach((node, i) => {
        node.size = shares[i];
    });
    return clone;
}

/**
 * The two meanings of "even these out" on a grid.
 *
 * `tree` equalizes at every split, so a column beside a column of two rows ends
 * up half and half. `area` equalizes the space each group gets, so that same
 * layout ends up a third and two thirds, because the split column is housing
 * two groups. Emacs ships both, as `balance-windows` and `balance-windows-area`,
 * and they are the only two answers anyone gives to the question.
 *
 * On a flat row of columns they are identical, which is why this only shows up
 * once a layout has depth.
 */
export type BalanceMode = 'tree' | 'area';

/** Rewrites `nodes` in place so each split is shared out by the chosen rule. */
function rebalance(nodes: LayoutNode[], total: number, byArea: boolean): boolean {
    const weights = byArea ? nodes.map(node => leaves([node]).length) : nodes.map(() => 1);
    const shares = weightedSizes(total, weights);
    if (!shares) {
        return false;
    }
    for (const [i, node] of nodes.entries()) {
        node.size = shares[i];
        if (node.groups && node.groups.length > 0) {
            // The children's sizes run along the perpendicular axis, so their
            // total is the branch's own extent on that axis and not the width
            // just assigned. Redistributing within it leaves the branch's
            // footprint alone.
            const across = node.groups.reduce((sum, child) => sum + (child.size ?? 0), 0);
            if (!rebalance(node.groups, across, byArea)) {
                return false;
            }
        }
    }
    return true;
}

/** A whole layout balanced by one of the two rules, or undefined if it cannot be. */
export function balance(layout: EditorLayout, mode: BalanceMode): EditorLayout | undefined {
    const clone = JSON.parse(JSON.stringify(layout)) as EditorLayout;
    const total = clone.groups.reduce((sum, node) => sum + (node.size ?? 0), 0);
    if (clone.groups.length < 2 || !rebalance(clone.groups, total, mode === 'area')) {
        return undefined;
    }
    return clone;
}

/** Whether the leaf at `leafIndex` sits at the top level rather than in a branch. */
export function isTopLevelLeaf(nodes: LayoutNode[], leafIndex: number): boolean {
    return siblingsOf(nodes, leafIndex) === nodes;
}

/** The sibling list holding `leafIndex`, for a caller that only reads it. */
export function splitHolding(
    nodes: LayoutNode[],
    leafIndex: number
): readonly LayoutNode[] | undefined {
    return siblingsOf(nodes, leafIndex);
}

/**
 * Widths with the pinned columns held at their size and the rest sharing what
 * is left.
 *
 * `pins[i]` is the width column i is pinned to, or undefined when it is free.
 *
 * The pin is soft, which is what Vim's `winfixwidth` does and says so in its own
 * documentation: it "may be changed anyway when running out of room". A hard pin
 * turns any layout that no longer fits into a refusal, and refusing to open an
 * editor is worse than a column that shrank. So when the free columns cannot
 * clear their floors, the pins give ground proportionally, down to their own
 * floors, and only a layout that cannot be satisfied at all is refused.
 */
export function withPinnedWidths(
    sizes: number[],
    pins: (number | undefined)[],
    floors: number[]
): number[] | undefined {
    if (sizes.length === 0 || pins.length !== sizes.length || floors.length !== sizes.length) {
        return undefined;
    }
    const total = sizes.reduce((a, b) => a + b, 0);
    const free: number[] = [];
    const pinned: number[] = [];
    sizes.forEach((_, i) => (pins[i] === undefined ? free : pinned).push(i));

    // Everything pinned leaves nothing to absorb the difference, and the widths
    // would have to sum to the editor area by luck.
    if (free.length === 0 || pinned.length === 0) {
        return undefined;
    }

    // Strictly above the floor, since equality is what arms the expand.
    const freeNeed = free.reduce((sum, i) => sum + floors[i] + 1, 0);
    const pinnedNeed = pinned.reduce((sum, i) => sum + floors[i] + 1, 0);
    if (total < freeNeed + pinnedNeed) {
        return undefined;
    }

    let held = pinned.map(i => Math.max(floors[i] + 1, Math.round(pins[i] as number)));
    const heldTotal = held.reduce((a, b) => a + b, 0);
    if (heldTotal > total - freeNeed) {
        // The pins yield, in proportion, but never below their own floors.
        const room = total - freeNeed;
        const spare = heldTotal - pinnedNeed;
        const give = heldTotal - room;
        held = held.map((width, at) => {
            const i = pinned[at];
            const share = spare > 0 ? Math.ceil(((width - floors[i] - 1) / spare) * give) : 0;
            return Math.max(floors[i] + 1, width - share);
        });
    }

    const next = sizes.slice();
    held.forEach((width, at) => {
        next[pinned[at]] = width;
    });
    const rest = weightedSizes(
        total - held.reduce((a, b) => a + b, 0),
        free.map(() => 1)
    );
    if (!rest) {
        return undefined;
    }
    free.forEach((i, at) => {
        next[i] = rest[at];
    });

    if (next.some((size, i) => size <= floors[i])) {
        return undefined;
    }
    return next;
}

/** A geometry kept for a workspace, with what it was measured against. */
export interface RememberedLayout {
    /** Editor area width when it was saved. */
    width: number;
    /** Groups it was saved with. */
    leafCount: number;
    layout: EditorLayout;
}

/** Widths within this fraction of each other count as the same screen. */
const WIDTH_TOLERANCE = 0.02;

/**
 * Whether a remembered geometry can be put back.
 *
 * A layout saved on a 3440px screen restores as something unusable on a laptop:
 * columns land under their minimums and VS Code clamps them onto the exact width
 * that arms the expand. The group count has to match too, because these are
 * widths and nothing else; restoring a different shape would move editors.
 */
export function canRestore(
    saved: RememberedLayout | undefined,
    width: number | undefined,
    leafCount: number
): boolean {
    if (!saved || width === undefined || saved.width <= 0) {
        return false;
    }
    if (saved.leafCount !== leafCount) {
        return false;
    }
    return Math.abs(width - saved.width) <= Math.max(8, saved.width * WIDTH_TOLERANCE);
}

/** How far above the floor a corrected column is placed. */
export const CORRECTION_MARGIN = 24;

/**
 * VS Code's editor minimum, `DEFAULT_EDITOR_MIN_DIMENSIONS` in editor.ts.
 * Applies to text, chat, webview, custom, terminal, notebook and diff panes.
 */
export const DEFAULT_FLOOR = 220;

/** SettingsEditor2 overrides the minimum with its own `EDITOR_MIN_WIDTH`. */
export const SETTINGS_FLOOR = 500;

/**
 * The other half of `DEFAULT_EDITOR_MIN_DIMENSIONS`.
 *
 * doRestoreGroup expands on `viewSize.height === group.minimumHeight` just as
 * readily as on the width, so a stack of rows squeezed onto 70 is armed exactly
 * the way a column on 220 is.
 */
export const DEFAULT_HEIGHT_FLOOR = 70;

/**
 * Editor area width in CSS pixels, or undefined when the layout cannot say.
 *
 * Top-level sizes are measured along the layout's own axis: with orientation 0
 * they are widths and sum to the editor area width, with orientation 1 they are
 * heights and say nothing about width. A stacked layout that holds a horizontal
 * split does expose widths, through that branch's children.
 *
 * Sub-pixel totals mean the grid has not laid out yet and the sizes are still
 * the raw weights they were written with, which are not a measurement.
 */
export function measureEditorWidth(layout: EditorLayout, floor: number): number | undefined {
    // With orientation 1 every row spans the full editor width, so the first
    // row that holds a horizontal split reports the same total as any other.
    const across =
        layout.orientation === 0
            ? layout.groups
            : layout.groups.find(n => n.groups && n.groups.length > 0)?.groups ?? [];

    if (across.length === 0) {
        return undefined;
    }

    // Every size must be a plausible pixel width, and a laid-out column can
    // never be narrower than the floor VS Code enforces. Testing the sum
    // instead lets weights through whenever they happen to add up past the
    // threshold, and a single-column write is the weight 1 exactly, which
    // sailed past an earlier `>= 1` rule and reported a 1px editor area.
    const sizes = across.map(n => n.size ?? 0);
    if (sizes.some(size => size < floor)) {
        return undefined;
    }
    return sizes.reduce((total, size) => total + size, 0);
}

/**
 * The narrowest editor area in which `columns` can all sit clear of their
 * floors.
 *
 * Panes do not share one minimum. Splitting into N columns has to house every
 * pane that is open now, each above its own floor, plus `defaultFloor` for any
 * column that ends up empty. The widest floors are the binding constraint, so
 * they are the ones counted. Each floor gets +1 because clearing the floor means
 * strictly above it: equality is what arms the expand.
 */
export function requiredWidth(columns: number, floors: number[], defaultFloor: number): number {
    const widest = [...floors].sort((a, b) => b - a).slice(0, columns);
    while (widest.length < columns) {
        widest.push(defaultFloor);
    }
    return widest.reduce((total, floor) => total + floor + 1, 0);
}

/**
 * The most columns `editorWidth` can hold with every one clear of its floor, or
 * undefined when the width is unknown.
 */
export function maxColumns(
    editorWidth: number | undefined,
    floors: number[],
    defaultFloor: number
): number | undefined {
    if (editorWidth === undefined) {
        return undefined;
    }
    let fits = 1;
    // Bounded by the width itself, since every column costs at least one pixel.
    while (fits < 64 && requiredWidth(fits + 1, floors, defaultFloor) <= editorWidth) {
        fits++;
    }
    return fits;
}

/**
 * Whether splitting `editorWidth` into `columns` leaves any of them on or under
 * its floor, which is the width that arms VS Code's expand-on-click.
 *
 * An unknown width reports no risk. Warning on a number we do not have is how
 * the old 1920px assumption both over- and under-warned.
 */
export function floorRisk(
    editorWidth: number | undefined,
    columns: number,
    floors: number[],
    defaultFloor: number
): boolean {
    if (editorWidth === undefined || columns < 1) {
        return false;
    }
    return editorWidth < requiredWidth(columns, floors, defaultFloor);
}

/** Where one tab sat before a change that merged groups. */
export interface TabPlacement {
    /** Grid position of its group, 1-based, matching ViewColumn. */
    viewColumn: number;
    /** Position within that group, so the order inside a column survives too. */
    index: number;
    /**
     * Identity that outlives the merge. Tab objects are rebuilt whenever the
     * model changes, so a reference cannot be held across one; the resource is
     * used where a tab has one and the label otherwise.
     */
    key: string;
}

/**
 * One step of history: the geometry, plus where the tabs were when the change
 * was going to move them.
 */
export interface HistoryEntry {
    layout: EditorLayout;
    /**
     * Set only for a change that reduced the column count, which is the only
     * one that merges tabs into another group. Restoring geometry is enough for
     * everything else.
     */
    tabs?: TabPlacement[];
}

/**
 * Bounded history of layouts, newest last.
 *
 * Only user-initiated changes are recorded. Automatic floor corrections are
 * deliberately excluded: they fire on ordinary editor activity and would bury
 * the last change the user actually made, the way Emacs winner-mode excludes
 * its boring buffers.
 */
export class LayoutHistory {
    static readonly MAX = 20;
    private ring: HistoryEntry[] = [];

    record(entry: HistoryEntry): void {
        this.ring.push(entry);
        if (this.ring.length > LayoutHistory.MAX) {
            this.ring.shift();
        }
    }

    pop(): HistoryEntry | undefined {
        return this.ring.pop();
    }

    clear(): void {
        this.ring = [];
    }

    get size(): number {
        return this.ring.length;
    }
}

export interface Correction {
    /** Leaf sizes after correction, in the same depth-first order as `leaves`. */
    sizes: number[];
    /** Indexes of the leaves that were raised off the floor. */
    corrected: number[];
}

/**
 * Splits `total` across `weights`, preserving the total exactly.
 *
 * `setEditorLayout` normalizes whatever magnitudes it is given, so the weights
 * could be handed straight to it. They are resolved to pixels here instead
 * because the caller has to know the resulting widths to decide whether any of
 * them lands on a floor.
 *
 * The rounding remainder goes to the largest fractional parts, so the columns
 * that lost the most to flooring are the ones that get a pixel back.
 */
export function weightedSizes(total: number, weights: number[]): number[] | undefined {
    if (weights.length === 0 || !weights.every(weight => weight > 0 && Number.isFinite(weight))) {
        return undefined;
    }
    // A fractional total cannot be split into whole pixels that add back up to
    // it, and the only way one arrives here is a layout that has not been laid
    // out yet, whose sizes are still the raw weights they were written with.
    // Refusing says so; carrying on returned sizes of zero and a total that
    // drifted.
    if (!Number.isInteger(total) || total <= 0) {
        return undefined;
    }
    const sum = weights.reduce((a, b) => a + b, 0);
    const exact = weights.map(weight => (weight / sum) * total);
    const sizes = exact.map(Math.floor);
    const short = total - sizes.reduce((a, b) => a + b, 0);
    const byFraction = exact
        .map((value, i) => ({ i, fraction: value - Math.floor(value) }))
        .sort((a, b) => b.fraction - a.fraction);
    for (let given = 0; given < short; given++) {
        sizes[byFraction[given % byFraction.length].i]++;
    }
    // A column of no width is not a layout. This catches the total being too
    // small to go round, and the case the integer check above lets through:
    // raw weights of 0.5 and 0.5 sum to exactly 1, which is an integer, and
    // splitting 1px two ways leaves one of them on nothing.
    if (sizes.some(size => size <= 0)) {
        return undefined;
    }
    return sizes;
}

/** How the columns that were not given an explicit share soak up the rest. */
export type RemainderStrategy = 'even' | 'proportional';

/**
 * Widths after column `index` is given `percent` of the editor area.
 *
 * A count is often not what someone means: "make this one half the screen" is.
 * The rest is shared either equally or in proportion to what each column
 * already had, which are both defensible readings of "leave the others alone"
 * and differ visibly on an uneven layout.
 *
 * Refuses rather than producing a layout with a column on its floor, since that
 * is the state the whole extension exists to avoid.
 */
export function withColumnShare(
    sizes: number[],
    index: number,
    percent: number,
    strategy: RemainderStrategy,
    floors: number[]
): number[] | undefined {
    if (
        sizes.length < 2 ||
        index < 0 ||
        index >= sizes.length ||
        floors.length !== sizes.length ||
        !(percent > 0 && percent < 100)
    ) {
        return undefined;
    }
    const total = sizes.reduce((a, b) => a + b, 0);
    const share = Math.round((percent / 100) * total);
    const others = sizes.map((_, i) => i).filter(i => i !== index);

    const weights =
        strategy === 'even'
            ? others.map(() => 1)
            : others.map(i => (sizes[i] > 0 ? sizes[i] : 1));
    const rest = weightedSizes(total - share, weights);
    if (!rest) {
        return undefined;
    }

    const next = sizes.slice();
    next[index] = share;
    others.forEach((column, at) => {
        next[column] = rest[at];
    });

    // Strictly above the floor: equality is what arms the expand.
    if (next.some((size, i) => size <= floors[i])) {
        return undefined;
    }
    return next;
}

/**
 * The two widths that matter for one column, which are not always the same
 * number.
 *
 * `floor` is what arms the expand: a group whose width equals it is expanded on
 * the next click. `donorFloor` is what the pane will actually be clamped to if
 * space is taken from it. They differ for the panes VS Code's tab model cannot
 * classify. Settings really is clamped to 500, but Keyboard Shortcuts, the
 * Search editor, Welcome and the Extension editor look identical through the
 * API and sit at the ordinary 220, so treating all of them as 500-floored
 * yanked a 300px column out to 524 for no reason. Reading the needy side from
 * the width the column actually has, while keeping the donor side pessimistic,
 * gets both cases right: nothing is raised that was not armed, and nothing is
 * taken from a pane that would spring back to exactly its minimum.
 */
export interface ColumnFloor {
    floor: number;
    donorFloor: number;
}

/** True when the layout is a single flat row or column with no nested branches. */
export function isFlat(nodes: LayoutNode[]): boolean {
    return nodes.every(n => !n.groups || n.groups.length === 0);
}

/**
 * Raise every group that is on or under `floor` clear of it, taking the space
 * from groups that have headroom.
 *
 * Corrects all of them rather than only the active one. VS Code's expand runs
 * synchronously in the renderer inside doSetGroupActive, before the extension
 * host is even told the active group changed, so reacting to activation is
 * always too late. Disarming every group ahead of the click is the only ordering
 * an extension can win.
 *
 * Returns undefined when nothing needs doing, or when the donors cannot cover
 * the cost. Refusing is deliberate: forcing it would push a donor onto the floor
 * and simply move the trigger, and VS Code clamps a below-minimum request back
 * to exactly the minimum, which is the value that arms it.
 */
export function correctFloor(
    sizes: number[],
    floor: number | number[] | ColumnFloor[]
): Correction | undefined {
    if (sizes.length < 2) {
        return undefined;
    }
    const floors = normalizeFloors(sizes.length, floor);
    if (!floors) {
        return undefined;
    }
    // What a group is raised to when it is on its own floor.
    const raiseTo = floors.map(f => f.floor + CORRECTION_MARGIN);
    // What a group may not be pushed below when it funds someone else.
    const keep = floors.map(f => f.donorFloor + CORRECTION_MARGIN);

    const needy = sizes
        .map((size, i) => ({ i, deficit: size <= floors[i].floor ? raiseTo[i] - size : 0 }))
        .filter(n => n.deficit > 0);
    if (needy.length === 0) {
        return undefined;
    }

    const needed = needy.reduce((sum, n) => sum + n.deficit, 0);
    const donors = sizes
        .map((size, i) => ({ i, spare: size > keep[i] ? size - keep[i] : 0 }))
        .filter(d => d.spare > 0);
    const available = donors.reduce((sum, d) => sum + d.spare, 0);
    if (available < needed) {
        return undefined;
    }

    const next = sizes.slice();
    for (const n of needy) {
        next[n.i] = raiseTo[n.i];
    }

    let remaining = needed;
    for (const donor of donors) {
        if (remaining <= 0) {
            break;
        }
        // Every donor is capped at its own spare, so none can be pushed below
        // what it must keep. Rounding up keeps the loop converging; the final
        // clamp below settles any residue.
        const share = Math.min(donor.spare, Math.ceil((donor.spare / available) * needed), remaining);
        next[donor.i] -= share;
        remaining -= share;
    }

    // Total must be preserved exactly, or the write rescales the editor area.
    if (remaining !== 0) {
        const slack = donors.find(d => next[d.i] - remaining >= keep[d.i]);
        if (!slack) {
            return undefined;
        }
        next[slack.i] -= remaining;
    }

    return { sizes: next, corrected: needy.map(n => n.i) };
}

function normalizeFloors(
    count: number,
    floor: number | number[] | ColumnFloor[]
): ColumnFloor[] | undefined {
    if (typeof floor === 'number') {
        return Array.from({ length: count }, () => ({ floor, donorFloor: floor }));
    }
    if (floor.length !== count) {
        return undefined;
    }
    return floor.map(f => (typeof f === 'number' ? { floor: f, donorFloor: f } : f));
}

