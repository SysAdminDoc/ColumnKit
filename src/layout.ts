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

export interface Correction {
    /** Leaf sizes after correction, in the same depth-first order as `leaves`. */
    sizes: number[];
    /** Index of the leaf that was raised off the floor. */
    corrected: number;
}

/**
 * Raise the group at `index` clear of `floor`, taking the difference from
 * siblings that have room to give.
 *
 * Returns undefined when nothing needs doing, or when no sibling can spare the
 * space. Refusing is deliberate: forcing it would push another group onto the
 * floor and simply move the bug, and VS Code clamps a below-minimum request back
 * to exactly the minimum, which is the value that arms the expand-on-focus
 * trigger in the first place.
 */
export function correctFloor(
    sizes: number[],
    index: number,
    floor: number
): Correction | undefined {
    if (index < 0 || index >= sizes.length || sizes.length < 2) {
        return undefined;
    }
    const target = floor + CORRECTION_MARGIN;
    const current = sizes[index];
    if (current > floor) {
        return undefined;
    }

    const needed = target - current;
    const donors = sizes
        .map((size, i) => ({ i, spare: i === index ? 0 : Math.max(0, size - target) }))
        .filter(d => d.spare > 0);

    const available = donors.reduce((sum, d) => sum + d.spare, 0);
    if (available < needed) {
        return undefined;
    }

    const next = sizes.slice();
    next[index] = target;

    let remaining = needed;
    for (let n = 0; n < donors.length; n++) {
        const donor = donors[n];
        // Last donor absorbs the rounding remainder so the total is preserved.
        const take =
            n === donors.length - 1
                ? remaining
                : Math.min(donor.spare, Math.round((donor.spare / available) * needed));
        next[donor.i] -= take;
        remaining -= take;
    }

    return { sizes: next, corrected: index };
}
