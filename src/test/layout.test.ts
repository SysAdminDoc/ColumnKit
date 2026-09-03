import * as assert from 'assert';
import { CORRECTION_MARGIN, correctFloor, leaves } from '../layout';

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

    test('raises a group sitting exactly on the floor', () => {
        const result = correctFloor([220, 600], 0, floor);
        assert.ok(result, 'expected a correction');
        assert.strictEqual(result.sizes[0], floor + CORRECTION_MARGIN);
    });

    test('preserves the total width so the editor area is unchanged', () => {
        const before = [220, 600, 400];
        const result = correctFloor(before, 0, floor);
        assert.ok(result);
        const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
        assert.strictEqual(sum(result.sizes), sum(before));
    });

    test('leaves a group that is already clear of the floor alone', () => {
        assert.strictEqual(correctFloor([221, 600], 0, floor), undefined);
        assert.strictEqual(correctFloor([600, 600], 0, floor), undefined);
    });

    test('corrects a group below the floor, not only one exactly on it', () => {
        const result = correctFloor([100, 900], 0, floor);
        assert.ok(result);
        assert.strictEqual(result.sizes[0], floor + CORRECTION_MARGIN);
    });

    test('refuses when no sibling can spare the space', () => {
        // Both neighbours are themselves on the floor. Taking from them would
        // just move the bug to another column.
        assert.strictEqual(correctFloor([220, 220, 220], 0, floor), undefined);
    });

    test('never pushes a donor below the target width', () => {
        const result = correctFloor([220, 250, 260], 0, floor);
        if (result) {
            for (let i = 1; i < result.sizes.length; i++) {
                assert.ok(
                    result.sizes[i] >= floor,
                    `donor ${i} fell to ${result.sizes[i]}, at or under the floor`
                );
            }
        }
    });

    test('refuses degenerate input rather than throwing', () => {
        assert.strictEqual(correctFloor([220], 0, floor), undefined);
        assert.strictEqual(correctFloor([220, 600], -1, floor), undefined);
        assert.strictEqual(correctFloor([220, 600], 9, floor), undefined);
    });
});
