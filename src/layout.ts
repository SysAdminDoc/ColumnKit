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

