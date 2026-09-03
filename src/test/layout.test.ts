import * as assert from 'assert';
import { CORRECTION_MARGIN, correctFloor, describeColumnChange, isFlat, leaves } from '../layout';

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