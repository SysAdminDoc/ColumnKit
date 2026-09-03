import * as assert from 'assert';
import * as vscode from 'vscode';

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
