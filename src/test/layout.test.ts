import * as assert from 'assert';
import {
    CORRECTION_MARGIN,
    LayoutHistory,
    correctFloor,
    describeColumnChange,
    floorRisk,
    isFlat,
    leaves,
    measureEditorWidth
} from '../layout';

suite('LayoutHistory', () => {
    const layout = (n: number) => ({ orientation: 0 as const, groups: [{ size: n }] });

    test('returns the most recent layout first', () => {
        const history = new LayoutHistory();
        history.record(layout(1));
        history.record(layout(2));
        assert.deepStrictEqual(history.pop(), layout(2));
        assert.deepStrictEqual(history.pop(), layout(1));
    });

    test('reports nothing to undo when empty', () => {
        assert.strictEqual(new LayoutHistory().pop(), undefined);
        assert.strictEqual(new LayoutHistory().size, 0);
    });

    test('drops the oldest entry once full rather than growing without bound', () => {
        const history = new LayoutHistory();
        for (let i = 0; i < LayoutHistory.MAX + 5; i++) {
            history.record(layout(i));
        }
        assert.strictEqual(history.size, LayoutHistory.MAX);
        // The newest survives and the oldest five are gone, so the entry left at
        // the bottom is the sixth one recorded.
        assert.deepStrictEqual(history.pop(), layout(LayoutHistory.MAX + 4));
        for (let i = 0; i < LayoutHistory.MAX - 1; i++) {
            history.pop();
        }
        assert.strictEqual(history.size, 0);
    });

    test('clears, so a second activation does not inherit an old stack', () => {
        const history = new LayoutHistory();
        history.record(layout(1));
        history.record(layout(2));
        history.clear();
        assert.strictEqual(history.size, 0);
        assert.strictEqual(history.pop(), undefined);
    });

    test('tracks its size as entries go in and out', () => {
        const history = new LayoutHistory();
        assert.strictEqual(history.size, 0);
        history.record(layout(1));
        assert.strictEqual(history.size, 1);
        history.pop();
        assert.strictEqual(history.size, 0);
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

suite('floorRisk', () => {
    const floor = 220;

    test('warns when the columns would land on the floor', () => {
        // 852 / 4 = 213, under the floor.
        assert.strictEqual(floorRisk(852, 4, floor), true);
    });

    test('warns when they land exactly on it, which is what arms the expand', () => {
        assert.strictEqual(floorRisk(880, 4, floor), true);
    });

    test('stays quiet when the columns fit', () => {
        // 852 / 3 = 284.
        assert.strictEqual(floorRisk(852, 3, floor), false);
    });

    test('stays quiet for 8 columns on the wide display', () => {
        // 3440x1440 at 125% is 2752 CSS px, so 8 columns is 344 each. The old
        // 1920px assumption warned here, wrongly.
        assert.strictEqual(floorRisk(2752, 8, floor), false);
    });

    test('warns for 6 columns in a narrow window, where the old guess stayed quiet', () => {
        // 1280 / 6 = 213. Under the 1920 assumption this was silent.
        assert.strictEqual(floorRisk(1280, 6, floor), true);
    });

    test('warns when an integer split puts most columns on the floor', () => {
        // 2641 / 12 averages 220.08, fractionally clear of the floor, but the
        // real split is eleven columns at 220 and one at 221. Judging the mean
        // let this through.
        assert.strictEqual(floorRisk(2641, 12, floor), true);
    });

    test('still passes a split whose narrowest column clears the floor', () => {
        // 2652 / 12 = 221 exactly, so every column is clear.
        assert.strictEqual(floorRisk(2652, 12, floor), false);
    });

    test('reports no risk when the width is unknown', () => {
        assert.strictEqual(floorRisk(undefined, 12, floor), false);
    });

    test('refuses a nonsense column count rather than dividing by zero', () => {
        assert.strictEqual(floorRisk(852, 0, floor), false);
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
});