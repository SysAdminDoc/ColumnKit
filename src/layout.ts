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

export interface ColumnChange {
    /** Column count that was requested. */
    columns: number;
    /** Column count before the change. */
    before: number;
    /** Whether the result may leave columns on the minimum-width floor. */
    floorRisk: boolean;
}

/**
 * One message describing the whole outcome.
 *
 * Two consecutive setStatusBarMessage calls do not queue: the second replaces
 * the first. Reporting the merge and the floor risk separately meant the merge
 * notice was destroyed in exactly the case that carried both.
 */
export function describeColumnChange(change: ColumnChange): string {
    const { columns, before, floorRisk } = change;
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

    let outcome: string;
    if (columns < before) {
        outcome = `${columns} columns, ${plural(before - columns, 'column')} merged into the last one. Nothing was closed.`;
    } else if (columns > before) {
        outcome = `${columns} columns, ${plural(columns - before, 'empty column')} added.`;
    } else {
        outcome = `${columns} columns, evened.`;
    }

    const risk = floorRisk ? ' Columns may sit at the minimum width and expand on click.' : '';
    return `ColumnKit: ${outcome}${risk}`;
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
    private ring: EditorLayout[] = [];

    record(layout: EditorLayout): void {
        this.ring.push(layout);
        if (this.ring.length > LayoutHistory.MAX) {
            this.ring.shift();
        }
    }

    pop(): EditorLayout | undefined {
        return this.ring.pop();
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
    floor: number
): Correction | undefined {
    if (sizes.length < 2) {
        return undefined;
    }
    const target = floor + CORRECTION_MARGIN;
    const needy = sizes
        .map((size, i) => ({ i, deficit: size <= floor ? target - size : 0 }))
        .filter(n => n.deficit > 0);
    if (needy.length === 0) {
        return undefined;
    }

    const needed = needy.reduce((sum, n) => sum + n.deficit, 0);
    const donors = sizes
        .map((size, i) => ({ i, spare: size > target ? size - target : 0 }))
        .filter(d => d.spare > 0);
    const available = donors.reduce((sum, d) => sum + d.spare, 0);
    if (available < needed) {
        return undefined;
    }

    const next = sizes.slice();
    for (const n of needy) {
        next[n.i] = target;
    }

    let remaining = needed;
    for (const donor of donors) {
        if (remaining <= 0) {
            break;
        }
        // Every donor is capped at its own spare, so none can be pushed below
        // target. Rounding up keeps the loop converging; the final clamp below
        // settles any residue.
        const share = Math.min(donor.spare, Math.ceil((donor.spare / available) * needed), remaining);
        next[donor.i] -= share;
        remaining -= share;
    }

    // Total must be preserved exactly, or the write rescales the editor area.
    if (remaining !== 0) {
        const slack = donors.find(d => next[d.i] - remaining >= target);
        if (!slack) {
            return undefined;
        }
        next[slack.i] -= remaining;
    }

    return { sizes: next, corrected: needy.map(n => n.i) };
}

