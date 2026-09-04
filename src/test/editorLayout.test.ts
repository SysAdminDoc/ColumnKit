import * as assert from 'assert';
import * as vscode from 'vscode';
import { EditorLayout, floorRisk, measureEditorWidth } from '../layout';

/**
 * CK-1. `vscode.getEditorLayout` is untyped and its own doc comment says sizes
 * are ratios summing to 1, while the workbench source serializes `node.box.width`,
 * which is a CSS pixel value. Every measurement-based feature depends on which is
 * true, so this asserts the distinction against a live window rather than trusting
 * either the comment or the source read.
 */

interface ProbedLayout {
    orientation: number;
    groups: { size?: number }[];
}

async function readLayout(): Promise<ProbedLayout> {
    return (await vscode.commands.executeCommand('vscode.getEditorLayout')) as ProbedLayout;
}

suite('vscode.getEditorLayout', () => {
    test('returns group sizes denominated in CSS pixels, not ratios summing to 1', async () => {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 0.5 }, { size: 0.3 }, { size: 0.2 }]
        });

        const layout = await readLayout();
        const sizes = layout.groups.map(g => g.size ?? 0);
        const total = sizes.reduce((a, b) => a + b, 0);

        // Printed so the drain can record the observed values, not just pass/fail.
        console.log(`COLUMNKIT_PROBE orientation=${layout.orientation}`);
        console.log(`COLUMNKIT_PROBE sizes=${JSON.stringify(sizes)}`);
        console.log(`COLUMNKIT_PROBE total=${total}`);

        assert.strictEqual(layout.groups.length, 3, 'expected the three groups just written');

        // A ratio-denominated result sums to ~1. Anything summing well past that is
        // a pixel measurement. This is a property check, not a pinned magic number.
        assert.ok(
            total > 2,
            `expected pixel-scale sizes but the sizes sum to ${total}, which indicates normalized ratios`
        );
    });

    test('measures a live editor area, and the risk verdict flips at the real width', async () => {
        // CK-6. The warning used to be computed against a hardcoded 1920px.
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 0.5 }, { size: 0.3 }, { size: 0.2 }]
        });

        let live: EditorLayout | undefined;
        for (let attempt = 0; attempt < 50; attempt++) {
            live = await vscode.commands.executeCommand<EditorLayout>('vscode.getEditorLayout');
            if (live.groups.every(g => (g.size ?? 0) >= 1)) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 20));
        }

        const floor = 220;
        const width = measureEditorWidth(live!, floor);
        assert.ok(width !== undefined, 'a settled flat layout must yield a width');
        console.log(`COLUMNKIT_PROBE editorWidth=${width}`);

        // Independent of the implementation: the editor area has to be wide
        // enough to hold the groups it is currently displaying, and no wider
        // than the whole screen could plausibly be.
        assert.ok(
            width >= live!.groups.length * floor,
            `measured ${width} for ${live!.groups.length} groups, narrower than their own minimums`
        );
        assert.ok(width < 20000, `measured ${width}, which is not a plausible editor area`);

        // The verdict must follow the measurement rather than a constant: at
        // this width there is some column count that fits and some that does not.
        // The most columns that stay STRICTLY above the floor. An exact multiple
        // lands every column on it, and equality is what arms the expand, so
        // Math.floor would name a count that is itself risky.
        const fits = Math.floor(width / (floor + 1));
        assert.ok(fits >= 1, `editor area ${width} cannot hold even one column`);
        const ordinary: number[] = [];
        assert.strictEqual(floorRisk(width, fits, ordinary, floor), false, `${fits} columns should fit`);
        assert.strictEqual(floorRisk(width, fits + 1, ordinary, floor), true, `${fits + 1} columns should not`);
    });

    test('write accepts relative weights, so a read result can be fed straight back', async () => {
        await vscode.commands.executeCommand('vscode.setEditorLayout', {
            orientation: 0,
            groups: [{ size: 0.5 }, { size: 0.5 }]
        });
        const before = await readLayout();

        // Round-trip the pixel values from the read straight into a write. If the
        // write did not normalize arbitrary magnitudes this would collapse.
        await vscode.commands.executeCommand('vscode.setEditorLayout', before);
        const after = await readLayout();

        assert.strictEqual(after.groups.length, before.groups.length);
        const beforeTotal = before.groups.reduce((a, g) => a + (g.size ?? 0), 0);
        const afterTotal = after.groups.reduce((a, g) => a + (g.size ?? 0), 0);
        console.log(`COLUMNKIT_PROBE roundtrip before=${beforeTotal} after=${afterTotal}`);
        assert.ok(
            Math.abs(beforeTotal - afterTotal) < 2,
            `round-tripping a read into a write changed the total from ${beforeTotal} to ${afterTotal}`
        );
    });
});
