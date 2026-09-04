import * as assert from 'assert';
import {
    CORRECTION_MARGIN,
    DEFAULT_FLOOR,
    SETTINGS_FLOOR,
    LayoutHistory,
    canRestore,
    correctFloor,
    evenSplit,
    floorRisk,
    isFlat,
    isTopLevelLeaf,
    leaves,
    maxColumns,
    measureEditorWidth,
    requiredWidth,
    weightedSizes,
    withColumnShare,
    withPinnedWidths
} from '../layout';
import { describeColumnChange } from '../extension';

suite('LayoutHistory', () => {
    // An entry now carries the geometry plus, for a change that merged groups,
    // where the tabs were. These assert on `.layout` for that reason.
    const layout = (n: number) => ({ orientation: 0 as const, groups: [{ size: n }] });
    const entry = (n: number) => ({ layout: layout(n) });

    test('returns the most recent layout first', () => {
        const history = new LayoutHistory();
        history.record(entry(1));
        history.record(entry(2));
        assert.deepStrictEqual(history.pop()?.layout, layout(2));
        assert.deepStrictEqual(history.pop()?.layout, layout(1));
    });

    test('reports nothing to undo when empty', () => {
        assert.strictEqual(new LayoutHistory().pop(), undefined);
        assert.strictEqual(new LayoutHistory().size, 0);
    });

    test('drops the oldest entry once full rather than growing without bound', () => {
        const history = new LayoutHistory();
        for (let i = 0; i < LayoutHistory.MAX + 5; i++) {
            history.record(entry(i));
        }
        assert.strictEqual(history.size, LayoutHistory.MAX);
        // The newest survives and the oldest five are gone, so the entry left at
        // the bottom is the sixth one recorded.
        assert.deepStrictEqual(history.pop()?.layout, layout(LayoutHistory.MAX + 4));
        for (let i = 0; i < LayoutHistory.MAX - 1; i++) {
            history.pop();
        }
        assert.strictEqual(history.size, 0);
    });

    test('clears, so a second activation does not inherit an old stack', () => {
        const history = new LayoutHistory();
        history.record(entry(1));
        history.record(entry(2));
        history.clear();
        assert.strictEqual(history.size, 0);
        assert.strictEqual(history.pop(), undefined);
    });

    test('tracks its size as entries go in and out', () => {
        const history = new LayoutHistory();
        assert.strictEqual(history.size, 0);
        history.record(entry(1));
        assert.strictEqual(history.size, 1);
        history.pop();
        assert.strictEqual(history.size, 0);
    });

    test('carries tab placement back out with the layout that recorded it', () => {
        // CK-37. Geometry alone recreates the empty columns and leaves every
        // merged tab where the merge put it, so the placement has to survive
        // the round trip through the ring.
        const history = new LayoutHistory();
        const tabs = [
            { viewColumn: 1, index: 0, key: 'file:///a one' },
            { viewColumn: 3, index: 1, key: 'file:///b two' }
        ];
        history.record({ layout: layout(1), tabs });
        history.record({ layout: layout(2) });
        assert.strictEqual(history.pop()?.tabs, undefined, 'a non-merging change records no tabs');
        assert.deepStrictEqual(history.pop()?.tabs, tabs);
    });
});

suite('leaves', () => {
    test('returns a flat list for a flat layout', () => {
        assert.deepStrictEqual(leaves([{ size: 1 }, { size: 2 }]).map(n => n.size), [1, 2]);
    });

    test('walks nested groups depth-first', () => {
        const nested = [
            { size: 1 },
            { size: 5, groups: [{ size: 2 }, { size: 3 }] },
            { size: 4 }
        ];
        assert.deepStrictEqual(leaves(nested).map(n => n.size), [1, 2, 3, 4]);
    });

    test('treats an empty groups array as a leaf', () => {
        assert.deepStrictEqual(leaves([{ size: 7, groups: [] }]).map(n => n.size), [7]);
    });
});

suite('correctFloor', () => {
    const floor = 220;
    const target = floor + CORRECTION_MARGIN;
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    test('raises a group sitting exactly on the floor', () => {
        const result = correctFloor([220, 600], floor);
        assert.ok(result, 'expected a correction');
        assert.strictEqual(result.sizes[0], target);
    });

    test('raises EVERY group on the floor, not just one', () => {
        // The whole point: VS Code expands on activation before the extension
        // host is told, so each group must be disarmed before it is clicked.
        const result = correctFloor([220, 220, 1400], floor);
        assert.ok(result);
        assert.strictEqual(result.sizes[0], target);
        assert.strictEqual(result.sizes[1], target);
        assert.deepStrictEqual(result.corrected, [0, 1]);
    });

    test('preserves the total width exactly', () => {
        for (const before of [[220, 600, 400], [220, 220, 1400], [100, 900], [220, 245, 900]]) {
            const result = correctFloor(before, floor);
            if (result) {
                assert.strictEqual(sum(result.sizes), sum(before), `total moved for ${before}`);
            }
        }
    });

    test('leaves a group that is already clear of the floor alone', () => {
        assert.strictEqual(correctFloor([221, 600], floor), undefined);
        assert.strictEqual(correctFloor([600, 600], floor), undefined);
    });

    test('corrects a group below the floor, not only one exactly on it', () => {
        const result = correctFloor([100, 900], floor);
        assert.ok(result);
        assert.strictEqual(result.sizes[0], target);
    });

    test('refuses when no sibling can spare the space', () => {
        assert.strictEqual(correctFloor([220, 220, 220], floor), undefined);
    });

    test('never leaves any group below the target, over a wide input sweep', () => {
        // Replaces an earlier version of this test whose assertions sat inside
        // `if (result)` on an input that always refused, so the body never ran.
        let corrections = 0;
        for (let a = 200; a <= 260; a += 4) {
            for (let b = 230; b <= 400; b += 7) {
                for (let c = 230; c <= 900; c += 31) {
                    const before = [a, b, c];
                    const result = correctFloor(before, floor);
                    if (!result) {
                        continue;
                    }
                    corrections++;
                    assert.strictEqual(sum(result.sizes), sum(before), `total moved for ${before}`);
                    // The safety property is that nothing is left ON or UNDER the
                    // floor, which is what arms the expand. A group that started
                    // above the floor but below target was never armed and must
                    // not be moved.
                    for (let i = 0; i < result.sizes.length; i++) {
                        assert.ok(
                            result.sizes[i] > floor,
                            `${before} -> ${result.sizes} left index ${i} at ${result.sizes[i]}, on or under floor ${floor}`
                        );
                    }
                }
            }
        }
        // Guards against the sweep silently exercising nothing.
        assert.ok(corrections > 50, `sweep only produced ${corrections} corrections`);
    });

    test('refuses degenerate input rather than throwing', () => {
        assert.strictEqual(correctFloor([220], floor), undefined);
        assert.strictEqual(correctFloor([], floor), undefined);
    });

    test('honours a different floor per group', () => {
        // CK-12. A Settings pane arms the expand at 500, so 400px is on its
        // floor while the same width is comfortably clear for a chat panel.
        const result = correctFloor([400, 1200], [SETTINGS_FLOOR, DEFAULT_FLOOR]);
        assert.ok(result, 'the 500-floor group should have been raised');
        assert.strictEqual(result.sizes[0], SETTINGS_FLOOR + CORRECTION_MARGIN);
        assert.deepStrictEqual(result.corrected, [0]);
        assert.strictEqual(result.sizes[0] + result.sizes[1], 1600, 'total moved');
    });

    test('leaves a group alone that only looks floored under the wrong floor', () => {
        // 400 is far above 220, so with ordinary panes there is nothing to do.
        assert.strictEqual(correctFloor([400, 1200], [DEFAULT_FLOOR, DEFAULT_FLOOR]), undefined);
    });

    test('does not treat a wide-floor group as a donor below its own target', () => {
        // 540 is above the default target but below the Settings target of 524
        // plus nothing to spare, so it must not fund another group's deficit.
        const result = correctFloor([220, 540], [DEFAULT_FLOOR, SETTINGS_FLOOR]);
        assert.strictEqual(result, undefined, 'the Settings group has no spare to give');
    });

    test('refuses a floor list that does not line up with the sizes', () => {
        assert.strictEqual(correctFloor([220, 600, 900], [220, 220]), undefined);
    });

    // CK-39. `tab.input === undefined` covers Settings, Keyboard Shortcuts, the
    // Search editor, Welcome and the Extension editor, but only Settings is
    // really clamped to 500. So the width a column has decides whether it is on
    // a floor, while the donor side stays pessimistic.
    const unclassifiable = { floor: DEFAULT_FLOOR, donorFloor: SETTINGS_FLOOR };
    const settingsOnFloor = { floor: SETTINGS_FLOOR, donorFloor: SETTINGS_FLOOR };
    const ordinary = { floor: DEFAULT_FLOOR, donorFloor: DEFAULT_FLOOR };

    test('leaves an unclassifiable pane alone when it is not on any floor', () => {
        // Keyboard Shortcuts at 300 looks exactly like Settings through the API.
        // Treating it as 500-floored dragged the column out to 524 and moved a
        // sash the user never touched.
        assert.strictEqual(correctFloor([300, 552], [unclassifiable, ordinary]), undefined);
    });

    test('still raises Settings when it is parked on its own 500 floor', () => {
        const result = correctFloor([500, 900], [settingsOnFloor, ordinary]);
        assert.ok(result, 'a Settings pane at exactly 500 is armed and must be raised');
        assert.strictEqual(result.sizes[0], SETTINGS_FLOOR + CORRECTION_MARGIN);
        assert.strictEqual(sum(result.sizes), 1400, 'total moved');
    });

    test('will not take space from a pane that would spring back to its minimum', () => {
        // 540 clears the ordinary target but a pane that really wants 500 has
        // only 16px above its own, which cannot fund a 24px deficit. Taking it
        // anyway gets clamped back to exactly 500, arming the expand.
        assert.strictEqual(correctFloor([220, 540], [ordinary, unclassifiable]), undefined);
    });

    test('lets an unclassifiable pane donate once it is genuinely wide', () => {
        // Positive control for the test above: the pessimistic donor floor must
        // not mean such a pane can never lend anything.
        const result = correctFloor([220, 900], [ordinary, unclassifiable]);
        assert.ok(result);
        assert.strictEqual(result.sizes[0], DEFAULT_FLOOR + CORRECTION_MARGIN);
        assert.strictEqual(sum(result.sizes), 1120, 'total moved');
    });
});

suite('measureEditorWidth', () => {
    test('sums the top-level sizes of a column layout', () => {
        assert.strictEqual(
            measureEditorWidth({ orientation: 0, groups: [{ size: 412 }, { size: 220 }, { size: 220 }] }, 220),
            852
        );
    });

    test('reads widths from a branch when the top level is stacked rows', () => {
        // With orientation 1 the top-level sizes are heights. The horizontal
        // split inside one of those rows is what carries widths.
        const width = measureEditorWidth({
            orientation: 1,
            groups: [{ size: 300, groups: [{ size: 500 }, { size: 352 }] }, { size: 200 }]
        }, 220);
        assert.strictEqual(width, 852);
    });

    test('refuses stacked rows that expose no width at all', () => {
        assert.strictEqual(
            measureEditorWidth({ orientation: 1, groups: [{ size: 300 }, { size: 200 }] }, 220),
            undefined
        );
    });

    test('refuses raw weights, which are not a measurement', () => {
        // A read straight after a write returns the weights it was written with
        // until the grid lays out.
        assert.strictEqual(
            measureEditorWidth({ orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }] }, 220),
            undefined
        );
    });

    test('refuses the single-column weight, which is exactly 1', () => {
        // setColumns(1) writes { size: 1/1 }. Under a `>= 1` rule that read back
        // as a one-pixel editor area, and every subsequent count looked risky.
        assert.strictEqual(
            measureEditorWidth({ orientation: 0, groups: [{ size: 1 }] }, 220),
            undefined
        );
    });

    test('accepts a real single-column layout', () => {
        assert.strictEqual(
            measureEditorWidth({ orientation: 0, groups: [{ size: 2752 }] }, 220),
            2752
        );
    });

    test('refuses a column narrower than the floor, which cannot be a real width', () => {
        assert.strictEqual(
            measureEditorWidth({ orientation: 0, groups: [{ size: 219 }, { size: 600 }] }, 220),
            undefined
        );
    });
});

suite('requiredWidth', () => {
    const floor = 220;

    test('counts every column, each one pixel clear of the floor', () => {
        assert.strictEqual(requiredWidth(3, [], floor), 3 * 221);
    });

    test('houses the widest panes that are actually open', () => {
        // A Settings pane needs 500, so three columns with one open needs
        // 501 + 221 + 221, not 3 x 221.
        assert.strictEqual(requiredWidth(3, [SETTINGS_FLOOR, DEFAULT_FLOOR], floor), 501 + 221 + 221);
    });

    test('pads with the ordinary floor for columns that end up empty', () => {
        assert.strictEqual(requiredWidth(4, [SETTINGS_FLOOR], floor), 501 + 221 * 3);
    });

    test('ignores panes beyond the requested column count', () => {
        // Asking for one column cannot be constrained by four panes' floors.
        assert.strictEqual(requiredWidth(1, [220, 220, 220, 220], floor), 221);
    });
});

suite('maxColumns', () => {
    const floor = 220;
    const ordinary: number[] = [];

    test('stops one short of an exact multiple, which floors every column', () => {
        // 880 / 4 = 220 exactly, and equality is what arms the expand.
        assert.strictEqual(maxColumns(880, ordinary, floor), 3);
    });

    test('allows the largest count that stays clear of the floor', () => {
        assert.strictEqual(maxColumns(900, ordinary, floor), 4);
        assert.strictEqual(maxColumns(2752, ordinary, floor), 12);
        // 2641 across 12 looks fine on the average and is not: eleven of those
        // columns land on exactly 220.
        assert.strictEqual(maxColumns(2641, ordinary, floor), 11);
    });

    test('gives up a column when a wide pane is open', () => {
        // 2752 holds 12 ordinary columns, but a Settings pane eats 280 more.
        assert.strictEqual(maxColumns(2752, [SETTINGS_FLOOR], floor), 11);
    });

    test('never reports fewer than one column', () => {
        assert.strictEqual(maxColumns(100, ordinary, floor), 1);
    });

    test('reports nothing when the width is unknown', () => {
        assert.strictEqual(maxColumns(undefined, ordinary, floor), undefined);
    });

    test('agrees with floorRisk at every count', () => {
        // The cap and the warning must not disagree, or the extension warns
        // about a layout it just chose, or caps without warning.
        for (const width of [640, 852, 880, 900, 1280, 2000, 2641, 2752]) {
            for (const floors of [[], [SETTINGS_FLOOR], [SETTINGS_FLOOR, SETTINGS_FLOOR]]) {
                const fits = maxColumns(width, floors, floor)!;
                assert.strictEqual(
                    floorRisk(width, fits, floors, floor),
                    false,
                    `${width} with ${JSON.stringify(floors)} at ${fits}`
                );
                assert.strictEqual(
                    floorRisk(width, fits + 1, floors, floor),
                    true,
                    `${width} with ${JSON.stringify(floors)} at ${fits + 1}`
                );
            }
        }
    });
});

suite('floorRisk', () => {
    const floor = 220;
    const ordinary: number[] = [];

    test('warns when the columns would land on the floor', () => {
        assert.strictEqual(floorRisk(852, 4, ordinary, floor), true);
    });

    test('warns when they land exactly on it, which is what arms the expand', () => {
        assert.strictEqual(floorRisk(880, 4, ordinary, floor), true);
    });

    test('stays quiet when the columns fit', () => {
        assert.strictEqual(floorRisk(852, 3, ordinary, floor), false);
    });

    test('stays quiet for 8 columns on the wide display', () => {
        // 3440x1440 at 125% is 2752 CSS px. The old 1920px assumption warned here.
        assert.strictEqual(floorRisk(2752, 8, ordinary, floor), false);
    });

    test('warns for 6 columns in a narrow window, where the old guess stayed quiet', () => {
        assert.strictEqual(floorRisk(1280, 6, ordinary, floor), true);
    });

    test('warns when an integer split puts most columns on the floor', () => {
        // 2641 / 12 averages 220.08, and eleven of those columns are 220.
        assert.strictEqual(floorRisk(2641, 12, ordinary, floor), true);
    });

    test('still passes a split whose narrowest column clears the floor', () => {
        assert.strictEqual(floorRisk(2652, 12, ordinary, floor), false);
    });

    test('warns when a wide pane will not fit even though the average looks fine', () => {
        // 2000 / 9 = 222, clear of 220, but the open Settings pane needs 500 and
        // the eight others need 221 each: 2269 in all.
        assert.strictEqual(floorRisk(2000, 9, ordinary, floor), false);
        assert.strictEqual(floorRisk(2000, 9, [SETTINGS_FLOOR], floor), true);
    });

    test('reports no risk when the width is unknown', () => {
        assert.strictEqual(floorRisk(undefined, 12, ordinary, floor), false);
    });

    test('refuses a nonsense column count rather than dividing by zero', () => {
        assert.strictEqual(floorRisk(852, 0, ordinary, floor), false);
    });
});

suite('weightedSizes', () => {
    test('splits in proportion and preserves the total exactly', () => {
        assert.deepStrictEqual(weightedSizes(900, [1, 1, 1]), [300, 300, 300]);
        assert.deepStrictEqual(weightedSizes(800, [2, 1, 1]), [400, 200, 200]);
    });

    test('hands the rounding remainder out rather than losing it', () => {
        const sizes = weightedSizes(1000, [1, 1, 1]);
        assert.ok(sizes);
        assert.strictEqual(sizes.reduce((a, b) => a + b, 0), 1000);
        assert.deepStrictEqual([...sizes].sort((a, b) => a - b), [333, 333, 334]);
    });

    test('preserves the total across a sweep of awkward splits', () => {
        for (let total = 700; total <= 3000; total += 37) {
            for (const weights of [[1, 1], [2, 1, 1], [3, 2, 1], [1, 1, 1, 1, 1, 1, 1]]) {
                const sizes = weightedSizes(total, weights);
                assert.ok(sizes, `refused ${total} / ${weights}`);
                assert.strictEqual(
                    sizes.reduce((a, b) => a + b, 0),
                    total,
                    `total moved for ${total} / ${weights}`
                );
            }
        }
    });

    test('refuses weights that cannot describe a layout', () => {
        assert.strictEqual(weightedSizes(900, []), undefined);
        assert.strictEqual(weightedSizes(900, [1, 0]), undefined);
        assert.strictEqual(weightedSizes(900, [1, -2]), undefined);
        assert.strictEqual(weightedSizes(900, [1, Number.NaN]), undefined);
    });
});

suite('withColumnShare', () => {
    const floors = (n: number) => Array.from({ length: n }, () => DEFAULT_FLOOR);

    test('gives the named column its share and splits the rest evenly', () => {
        const next = withColumnShare([300, 300, 300], 1, 50, 'even', floors(3));
        assert.deepStrictEqual(next, [225, 450, 225]);
    });

    test('proportional keeps the other columns in their existing ratio', () => {
        // The two readings of "leave the others alone" differ visibly: even
        // would end 360/360 here, proportional ends 320/400.
        const next = withColumnShare([400, 300, 500], 1, 40, 'proportional', floors(3));
        assert.ok(next);
        assert.strictEqual(next[1], 480);
        assert.strictEqual(next[0] + next[2], 720);
        assert.ok(next[2] > next[0], 'the wider column should have stayed wider');

        const even = withColumnShare([400, 300, 500], 1, 40, 'even', floors(3));
        assert.ok(even);
        assert.strictEqual(even[0], even[2], 'even should have equalised them');
        assert.notDeepStrictEqual(next, even, 'the two strategies must differ here');
    });

    test('preserves the total whichever strategy is used', () => {
        for (const strategy of ['even', 'proportional'] as const) {
            for (const percent of [20, 33, 50, 66, 80]) {
                const next = withColumnShare([400, 500, 600, 700], 2, percent, strategy, floors(4));
                if (next) {
                    assert.strictEqual(next.reduce((a, b) => a + b, 0), 2200, `${strategy} ${percent}`);
                }
            }
        }
    });

    test('refuses a share that would put another column on its floor', () => {
        // 80% of 900 leaves 180 for two columns, which is under the minimum.
        assert.strictEqual(withColumnShare([300, 300, 300], 0, 80, 'even', floors(3)), undefined);
    });

    test('refuses a share that would put the named column on its floor', () => {
        assert.strictEqual(withColumnShare([300, 300, 300], 0, 20, 'even', floors(3)), undefined);
    });

    test('honours a column with a wider floor of its own', () => {
        // The Settings column cannot go under 500, so a share that would is refused.
        const settings = [DEFAULT_FLOOR, SETTINGS_FLOOR, DEFAULT_FLOOR];
        assert.strictEqual(withColumnShare([600, 600, 600], 0, 60, 'even', settings), undefined);
        assert.ok(withColumnShare([600, 600, 600], 1, 40, 'even', settings));
    });

    test('refuses nonsense input rather than producing a layout', () => {
        assert.strictEqual(withColumnShare([300], 0, 50, 'even', floors(1)), undefined);
        assert.strictEqual(withColumnShare([300, 300], 5, 50, 'even', floors(2)), undefined);
        assert.strictEqual(withColumnShare([300, 300], 0, 0, 'even', floors(2)), undefined);
        assert.strictEqual(withColumnShare([300, 300], 0, 100, 'even', floors(2)), undefined);
        assert.strictEqual(withColumnShare([300, 300], 0, 50, 'even', floors(3)), undefined);
    });
});

suite('evenSplit', () => {
    // A 2x2 grid: two columns, each split into two uneven rows.
    const grid = () => ({
        orientation: 0 as const,
        groups: [
            { size: 400, groups: [{ size: 100 }, { size: 300 }] },
            { size: 600, groups: [{ size: 150 }, { size: 250 }] }
        ]
    });

    test('evens the rows of the column the group is in, and nothing else', () => {
        // CK-20. evenEditorWidths distributes the whole grid, which is too
        // blunt: the other column should not move at all.
        const next = evenSplit(grid(), 0);
        assert.ok(next);
        assert.deepStrictEqual(next.groups[0].groups?.map(n => n.size), [200, 200]);
        assert.deepStrictEqual(
            next.groups[1],
            grid().groups[1],
            'the other column was touched'
        );
        assert.deepStrictEqual(
            next.groups.map(n => n.size),
            [400, 600],
            'the column widths should not have moved'
        );
    });

    test('evens the second column when the group is in that one', () => {
        const next = evenSplit(grid(), 2);
        assert.ok(next);
        assert.deepStrictEqual(next.groups[1].groups?.map(n => n.size), [200, 200]);
        assert.deepStrictEqual(next.groups[0], grid().groups[0], 'the first column was touched');
    });

    test('evens the columns when the group is a column of its own', () => {
        const layout = {
            orientation: 0 as const,
            groups: [{ size: 100 }, { size: 500 }, { size: 300 }]
        };
        const next = evenSplit(layout, 1);
        assert.ok(next);
        assert.deepStrictEqual(next.groups.map(n => n.size), [300, 300, 300]);
    });

    test('leaves the input untouched', () => {
        const layout = grid();
        evenSplit(layout, 0);
        assert.deepStrictEqual(layout, grid(), 'the caller\'s layout was mutated');
    });

    test('refuses a split of one, and an index that is not there', () => {
        assert.strictEqual(evenSplit({ orientation: 0, groups: [{ size: 900 }] }, 0), undefined);
        assert.strictEqual(evenSplit(grid(), 9), undefined);
    });

    test('preserves the total of the split it evens', () => {
        const next = evenSplit(grid(), 0);
        assert.ok(next);
        assert.strictEqual(
            next.groups[0].groups?.reduce((sum, n) => sum + (n.size ?? 0), 0),
            400
        );
    });
});

suite('withPinnedWidths', () => {
    const floors = (n: number) => Array.from({ length: n }, () => DEFAULT_FLOOR);
    const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

    test('holds the pin and evens the rest', () => {
        // CK-18. This is what Even has to do once a column is pinned, and what
        // evenEditorWidths cannot: it distributes everything.
        const next = withPinnedWidths([400, 300, 500], [500, undefined, undefined], floors(3));
        assert.deepStrictEqual(next, [500, 350, 350]);
    });

    test('holds two pins at once', () => {
        const next = withPinnedWidths([400, 300, 500, 400], [500, undefined, 300, undefined], floors(4));
        assert.ok(next);
        assert.strictEqual(next[0], 500);
        assert.strictEqual(next[2], 300);
        assert.strictEqual(next[1], next[3]);
        assert.strictEqual(sum(next), 1600);
    });

    test('preserves the total exactly', () => {
        for (let total = 900; total <= 3000; total += 53) {
            const sizes = [Math.floor(total / 2), Math.floor(total / 4), total - Math.floor(total / 2) - Math.floor(total / 4)];
            const next = withPinnedWidths(sizes, [400, undefined, undefined], floors(3));
            if (next) {
                assert.strictEqual(sum(next), total, `total moved at ${total}`);
            }
        }
    });

    test('the pin gives ground rather than making the layout unsatisfiable', () => {
        // Vim says the same of winfixwidth: it "may be changed anyway when
        // running out of room". Refusing to fit an editor is worse than a
        // column that shrank.
        // 900 total: two free columns need 221 each, leaving 458 for a pin
        // asking for 600.
        const next = withPinnedWidths([600, 150, 150], [600, undefined, undefined], floors(3));
        assert.ok(next, 'a pin that cannot be honoured must yield, not refuse');
        assert.ok(next[0] < 600, `the pin did not give any ground: ${JSON.stringify(next)}`);
        assert.ok(next[1] > DEFAULT_FLOOR && next[2] > DEFAULT_FLOOR, JSON.stringify(next));
        assert.strictEqual(sum(next), 900);
    });

    test('never yields below its own floor', () => {
        // 663 is exactly three columns' worth of minimum plus a pixel each, so
        // the pin has to come all the way down and stop dead on its floor.
        const next = withPinnedWidths([600, 33, 30], [600, undefined, undefined], floors(3));
        assert.ok(next, JSON.stringify(next));
        assert.strictEqual(sum(next), 663);
        for (const size of next) {
            assert.ok(size > DEFAULT_FLOOR, `left at ${size}: ${JSON.stringify(next)}`);
        }
    });

    test('refuses a layout that cannot be satisfied at all', () => {
        // Three columns needing 221 each cannot come out of 600.
        assert.strictEqual(
            withPinnedWidths([200, 200, 200], [300, undefined, undefined], floors(3)),
            undefined
        );
    });

    test('refuses when nothing is free to take up the slack', () => {
        assert.strictEqual(withPinnedWidths([400, 400], [400, 400], floors(2)), undefined);
        assert.strictEqual(
            withPinnedWidths([400, 400], [undefined, undefined], floors(2)),
            undefined,
            'no pins at all means there is nothing for this to do'
        );
    });

    test('honours a column with a wider floor of its own', () => {
        const mixed = [DEFAULT_FLOOR, SETTINGS_FLOOR, DEFAULT_FLOOR];
        const next = withPinnedWidths([900, 600, 300], [900, undefined, undefined], mixed);
        if (next) {
            assert.ok(next[1] > SETTINGS_FLOOR, `Settings column left at ${next[1]}`);
        }
    });

    test('refuses lists that do not line up', () => {
        assert.strictEqual(withPinnedWidths([400, 400], [400], floors(2)), undefined);
        assert.strictEqual(withPinnedWidths([400, 400], [400, undefined], floors(3)), undefined);
        assert.strictEqual(withPinnedWidths([], [], []), undefined);
    });
});

suite('canRestore', () => {
    const saved = { width: 2752, leafCount: 3, layout: { orientation: 0 as const, groups: [] } };

    test('restores onto the same screen', () => {
        assert.strictEqual(canRestore(saved, 2752, 3), true);
    });

    test('tolerates a couple of percent, for a side bar that moved', () => {
        assert.strictEqual(canRestore(saved, 2720, 3), true);
        assert.strictEqual(canRestore(saved, 2790, 3), true);
    });

    test('refuses a screen it was not measured on', () => {
        // CK-22. A geometry saved on a 3440px monitor lands every column under
        // its minimum on a laptop, and VS Code then clamps them onto exactly
        // the width that arms the expand.
        assert.strictEqual(canRestore(saved, 1280, 3), false);
        assert.strictEqual(canRestore(saved, 3800, 3), false);
    });

    test('refuses a different number of groups, which these widths cannot describe', () => {
        assert.strictEqual(canRestore(saved, 2752, 2), false);
        assert.strictEqual(canRestore(saved, 2752, 4), false);
    });

    test('refuses when there is nothing saved or nothing measured', () => {
        assert.strictEqual(canRestore(undefined, 2752, 3), false);
        assert.strictEqual(canRestore(saved, undefined, 3), false);
        assert.strictEqual(canRestore({ ...saved, width: 0 }, 2752, 3), false);
    });

    test('keeps a small window usable, where two percent is only a few pixels', () => {
        const narrow = { ...saved, width: 300 };
        assert.strictEqual(canRestore(narrow, 306, 3), true);
        assert.strictEqual(canRestore(narrow, 320, 3), false);
    });
});

suite('isTopLevelLeaf', () => {
    test('tells a column apart from a group inside one', () => {
        const layout = [{ size: 400, groups: [{ size: 100 }, { size: 300 }] }, { size: 600 }];
        assert.strictEqual(isTopLevelLeaf(layout, 0), false);
        assert.strictEqual(isTopLevelLeaf(layout, 1), false);
        assert.strictEqual(isTopLevelLeaf(layout, 2), true);
    });
});

suite('isFlat', () => {
    test('accepts a flat layout', () => {
        assert.strictEqual(isFlat([{ size: 1 }, { size: 2 }]), true);
    });

    test('rejects a nested layout, whose sizes mix widths and heights', () => {
        assert.strictEqual(isFlat([{ size: 1 }, { size: 2, groups: [{ size: 1 }, { size: 1 }] }]), false);
    });
});
suite('describeColumnChange', () => {
    test('reports a merge on its own', () => {
        const msg = describeColumnChange({ columns: 2, before: 5, floorRisk: false });
        assert.match(msg, /3 columns merged into the last one/);
        assert.ok(!/minimum width/.test(msg), 'should not mention floor risk when there is none');
    });

    test('reports floor risk on its own', () => {
        const msg = describeColumnChange({ columns: 4, before: 4, floorRisk: true });
        assert.match(msg, /evened/);
        assert.match(msg, /minimum width/);
    });

    test('reports a merge and floor risk in the SAME message', () => {
        // The regression this covers: two setStatusBarMessage calls do not queue,
        // so the risk notice used to destroy the merge notice.
        const msg = describeColumnChange({ columns: 2, before: 6, floorRisk: true });
        assert.match(msg, /4 columns merged into the last one/, 'merge fact lost');
        assert.match(msg, /minimum width/, 'floor-risk fact lost');
    });

    test('explains a capped request instead of silently delivering fewer', () => {
        const msg = describeColumnChange({ columns: 3, before: 2, floorRisk: false, requested: 8 });
        assert.match(msg, /8 columns will not fit/);
        assert.match(msg, /you have 3/);
    });

    test('says nothing about capping when the request was honoured', () => {
        const msg = describeColumnChange({ columns: 4, before: 2, floorRisk: false, requested: 4 });
        assert.ok(!/will not fit/.test(msg), `unexpected cap notice: ${msg}`);
    });

    test('reports added empty columns', () => {
        assert.match(
            describeColumnChange({ columns: 6, before: 4, floorRisk: false }),
            /2 empty columns added/
        );
    });

    test('uses singular wording for a single column', () => {
        assert.match(describeColumnChange({ columns: 4, before: 5, floorRisk: false }), /1 column merged/);
        assert.match(describeColumnChange({ columns: 5, before: 4, floorRisk: false }), /1 empty column added/);
    });

    test('says "1 column" when the result is a single column', () => {
        // CK-48. The leading count was hardcoded plural, so collapsing to one
        // column reported "1 columns".
        assert.match(describeColumnChange({ columns: 1, before: 1, floorRisk: false }), /1 column, evened/);
        assert.match(
            describeColumnChange({ columns: 1, before: 3, floorRisk: false }),
            /1 column, 2 columns merged/
        );
        for (const message of [
            describeColumnChange({ columns: 1, before: 1, floorRisk: false }),
            describeColumnChange({ columns: 1, before: 3, floorRisk: false }),
            describeColumnChange({ columns: 1, before: 2, floorRisk: false, requested: 6 })
        ]) {
            assert.doesNotMatch(message, /\b1 columns\b/, `plural for a single column: ${message}`);
        }
    });
});