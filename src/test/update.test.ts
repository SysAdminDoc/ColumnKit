import * as assert from 'assert';
import * as vscode from 'vscode';
import { api } from './helpers';
import {
    ASSET_PREFIX,
    RELEASE_PREFIX,
    Release,
    UPDATE_CHECK_INTERVAL_MS,
    decide,
    isNewer,
    isRelease,
    parseVersion,
    pickVsix,
    shouldCheck
} from '../update';

/**
 * CK-15, CK-40, CK-41, CK-45. The update path had no tests at all, reached
 * GitHub on every suite run, extracted a digest it never checked, and threw a
 * TypeError on any 200 whose body was not a release.
 */

const DIGEST = 'sha256:' + 'a'.repeat(64);

function release(overrides: Partial<Release> = {}): Release {
    return {
        tag_name: 'v9.9.9',
        html_url: `${RELEASE_PREFIX}releases/tag/v9.9.9`,
        assets: [
            {
                name: 'columnkit-9.9.9.vsix',
                browser_download_url: `${ASSET_PREFIX}v9.9.9/columnkit-9.9.9.vsix`,
                digest: DIGEST
            }
        ],
        ...overrides
    };
}

suite('shouldCheck', () => {
    test('checks when it has never checked', () => {
        assert.strictEqual(shouldCheck(undefined, 1_000), true);
    });

    test('waits out the interval, then checks on the boundary', () => {
        const now = 10 * UPDATE_CHECK_INTERVAL_MS;
        assert.strictEqual(shouldCheck(now - UPDATE_CHECK_INTERVAL_MS + 1, now), false);
        assert.strictEqual(shouldCheck(now - UPDATE_CHECK_INTERVAL_MS, now), true);
    });

    test('checks when the clock moved backwards rather than wedging', () => {
        // Otherwise a clock correction blocks the check until the original
        // deadline comes round again.
        assert.strictEqual(shouldCheck(5_000, 1_000), true);
    });
});

suite('parseVersion', () => {
    test('reads a plain version and pads missing parts', () => {
        assert.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3]);
        assert.deepStrictEqual(parseVersion('1.2'), [1, 2, 0]);
        assert.deepStrictEqual(parseVersion('1'), [1, 0, 0]);
    });

    test('drops a leading v and any pre-release or build metadata', () => {
        assert.deepStrictEqual(parseVersion('v1.2.3'), [1, 2, 3]);
        assert.deepStrictEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3]);
        assert.deepStrictEqual(parseVersion('1.2.3+build'), [1, 2, 3]);
    });

    test('refuses anything that is not a version', () => {
        for (const bad of ['', 'latest', '1.2.3.4', '1.x.3', 'v']) {
            assert.strictEqual(parseVersion(bad), undefined, `accepted ${JSON.stringify(bad)}`);
        }
    });
});

suite('isNewer', () => {
    test('compares each component in order', () => {
        assert.strictEqual(isNewer('0.1.0', '0.2.0'), true);
        assert.strictEqual(isNewer('0.9.0', '1.0.0'), true);
        assert.strictEqual(isNewer('0.1.0', '0.1.1'), true);
        assert.strictEqual(isNewer('0.2.0', '0.1.9'), false);
    });

    test('an identical version is not newer, which is what pins a stale tag', () => {
        // The shipped 0.1.0 can never be told about 0.1.0, which is why a
        // release has to carry a bumped version to reach anyone.
        assert.strictEqual(isNewer('0.1.0', '0.1.0'), false);
        assert.strictEqual(isNewer('0.1.0', 'v0.1.0'), false);
    });

    test('refuses to guess when either side is not a version', () => {
        assert.strictEqual(isNewer('0.1.0', 'nightly'), false);
        assert.strictEqual(isNewer('unknown', '9.9.9'), false);
    });
});

suite('isRelease', () => {
    test('accepts a real release body', () => {
        assert.strictEqual(isRelease(release()), true);
        assert.strictEqual(isRelease({ tag_name: 'v1', html_url: 'x', assets: [] }), true);
    });

    test('rejects every malformed body that used to throw a TypeError', () => {
        // Each of these reached tag_name.trim() or assets.find() before CK-41.
        for (const bad of [
            {},
            [],
            null,
            undefined,
            'v9',
            42,
            { tag_name: 'v9.0.0', html_url: 'x' },
            { tag_name: 'v9.0.0', html_url: 'x', assets: null },
            { tag_name: 'v9.0.0', html_url: 'x', assets: [{}] },
            { tag_name: 9, html_url: 'x', assets: [] }
        ]) {
            assert.strictEqual(isRelease(bad), false, `accepted ${JSON.stringify(bad)}`);
        }
    });

    test('tolerates a missing or null digest, which older releases have', () => {
        assert.strictEqual(
            isRelease({ tag_name: 'v1', html_url: 'x', assets: [{ name: 'a.vsix', browser_download_url: 'u' }] }),
            true
        );
        assert.strictEqual(
            isRelease({
                tag_name: 'v1',
                html_url: 'x',
                assets: [{ name: 'a.vsix', browser_download_url: 'u', digest: null }]
            }),
            true
        );
    });
});

suite('pickVsix', () => {
    test('returns the asset when it is on this repository and carries a digest', () => {
        assert.deepStrictEqual(pickVsix(release()), {
            url: `${ASSET_PREFIX}v9.9.9/columnkit-9.9.9.vsix`,
            sha256: 'a'.repeat(64)
        });
    });

    test('refuses an asset with no digest, since there is nothing to check', () => {
        const noDigest = release({
            assets: [{ name: 'a.vsix', browser_download_url: `${ASSET_PREFIX}v/a.vsix` }]
        });
        assert.strictEqual(pickVsix(noDigest), undefined);
    });

    test('refuses a malformed digest', () => {
        for (const digest of ['sha256:short', 'md5:' + 'a'.repeat(64), 'a'.repeat(64), '']) {
            const bad = release({
                assets: [{ name: 'a.vsix', browser_download_url: `${ASSET_PREFIX}v/a.vsix`, digest }]
            });
            assert.strictEqual(pickVsix(bad), undefined, `accepted digest ${JSON.stringify(digest)}`);
        }
    });

    test('refuses a download URL that is not this repository, whatever the digest says', () => {
        // CK-40. The URL arrives in the same body as the digest, so it is
        // pinned rather than trusted.
        for (const url of [
            'file:///C:/evil.vsix',
            'http://github.com/SysAdminDoc/ColumnKit/releases/download/v/a.vsix',
            'https://evil.example/a.vsix',
            'https://github.com/someone/else/releases/download/v/a.vsix'
        ]) {
            const bad = release({
                assets: [{ name: 'a.vsix', browser_download_url: url, digest: DIGEST }]
            });
            assert.strictEqual(pickVsix(bad), undefined, `accepted ${url}`);
        }
    });

    test('refuses a release with no vsix at all', () => {
        assert.strictEqual(pickVsix(release({ assets: [] })), undefined);
    });
});

suite('decide', () => {
    test('offers a newer release', () => {
        const decision = decide('0.1.0', release(), undefined);
        assert.ok(decision);
        assert.strictEqual(decision.version, '9.9.9');
        assert.ok(decision.asset, 'a pinned, digested asset should have come through');
    });

    test('says nothing about the current or an older version', () => {
        assert.strictEqual(decide('9.9.9', release(), undefined), undefined);
        assert.strictEqual(decide('10.0.0', release(), undefined), undefined);
    });

    test('keeps a skipped version skipped, but not a later one', () => {
        assert.strictEqual(decide('0.1.0', release(), '9.9.9'), undefined);
        assert.ok(decide('0.1.0', release(), '0.5.0'), 'an older skip must not silence a newer release');
    });

    test('ignores a skip that is not a version', () => {
        assert.ok(decide('0.1.0', release(), 'nonsense'));
    });

    test('returns undefined instead of throwing on a malformed body', () => {
        // CK-41. These are the exact bodies that threw before the guard.
        for (const bad of [{}, [], null, undefined, 'v9', { tag_name: 'v9.0.0', html_url: 'x' }]) {
            assert.strictEqual(decide('0.1.0', bad, undefined), undefined, `threw or accepted ${JSON.stringify(bad)}`);
        }
    });

    test('refuses a release whose notes link points somewhere else', () => {
        // The Release notes button opens this in a browser.
        const offsite = release({ html_url: 'https://evil.example/notes' });
        assert.strictEqual(decide('0.1.0', offsite, undefined), undefined);
    });

    test('still offers a release with no installable asset, as a link only', () => {
        const decision = decide('0.1.0', release({ assets: [] }), undefined);
        assert.ok(decision);
        assert.strictEqual(decision.asset, undefined, 'no asset means no Update button');
    });
});

suite('update check in the host', () => {
    test('makes no request at all when the setting is off', async () => {
        // CK-15's acceptance. The suite runs with checkForUpdates false, so
        // this also proves activation itself stayed silent.
        const columnKit = await api();
        const before = columnKit.updateRequests();
        await columnKit.checkForUpdate(Date.now() + 10 * UPDATE_CHECK_INTERVAL_MS);
        assert.strictEqual(columnKit.updateRequests(), before, 'a disabled check issued a request');
    });

    test('the whole suite has never reached GitHub', async () => {
        const columnKit = await api();
        assert.strictEqual(
            columnKit.updateRequests(),
            0,
            'something in the suite performed a live update request'
        );
    });

    test('survives a malformed release body instead of rejecting', async () => {
        const columnKit = await api();
        const cfg = vscode.workspace.getConfiguration('columnkit');
        await cfg.update('checkForUpdates', true, vscode.ConfigurationTarget.Global);
        const rejections: unknown[] = [];
        const watch = (reason: unknown) => rejections.push(reason);
        process.on('unhandledRejection', watch);
        try {
            // Cast because the whole point is handing it something that is not
            // a release, which is what any 200 from a captive portal looks like.
            const bad = (async () => ({}) as never) as () => Promise<never>;
            await columnKit.checkForUpdate(Date.now() + 10 * UPDATE_CHECK_INTERVAL_MS, bad);
            await new Promise(resolve => setTimeout(resolve, 100));
            assert.deepStrictEqual(rejections, [], 'a malformed body escaped as an unhandled rejection');
        } finally {
            process.off('unhandledRejection', watch);
            await cfg.update('checkForUpdates', undefined, vscode.ConfigurationTarget.Global);
        }
    });

    test('refuses to install bytes that do not match the published digest', async function () {
        // CK-40. installExtension downloads and installs a URI with no hash or
        // signature check of its own, so this gate is the only one there is.
        this.timeout(30000);
        const columnKit = await api();
        const decision = decide('0.1.0', release(), undefined);
        assert.ok(decision?.asset);

        await columnKit.installUpdate(decision, async () => Buffer.from('not the published bytes'));

        assert.match(
            columnKit.lastNotification()?.message ?? '',
            /did not match its checksum/,
            'a mismatched download was not reported'
        );
        assert.ok(
            !vscode.extensions.getExtension('SysAdminDoc.columnkit-9.9.9'),
            'a mismatched download must never be installed'
        );
    });

    test('lets matching bytes through the gate', async function () {
        // Positive control for the test above: without this, a gate that
        // refused everything would look identical. The editor then rejects the
        // fake archive, which is the expected end of this path.
        this.timeout(30000);
        const columnKit = await api();
        const bytes = Buffer.from('still not a real vsix, but the digest agrees');
        const crypto = await import('node:crypto');
        const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
        const decision = {
            version: '9.9.9',
            release: release(),
            asset: { url: `${ASSET_PREFIX}v9.9.9/columnkit-9.9.9.vsix`, sha256 }
        };

        // Getting past the gate emits nothing at all, so the test is whether
        // this call added a message. Comparing what notify() last recorded by
        // identity is what distinguishes "said nothing" from "said the same
        // thing again", which a text match cannot.
        const before = columnKit.lastNotification();
        try {
            await columnKit.installUpdate(decision, async () => bytes);
        } catch {
            // Expected: the archive is not a real extension.
        }
        assert.strictEqual(
            columnKit.lastNotification(),
            before,
            `the gate reported "${columnKit.lastNotification()?.message}" for bytes whose digest was correct`
        );
    });

    test('refuses an asset that is not a ColumnKit release download', async () => {
        // The prefix is enforced where the decision is built, but this function
        // is on the exported API and can be reached with a decision this
        // extension never made.
        const columnKit = await api();
        let fetched = false;
        await columnKit.installUpdate(
            {
                version: '9.9.9',
                release: release(),
                asset: { url: 'https://evil.example/columnkit.vsix', sha256: 'a'.repeat(64) }
            },
            async () => {
                fetched = true;
                return Buffer.from('anything');
            }
        );
        assert.strictEqual(fetched, false, 'it downloaded from a host it should have refused');
        assert.match(
            columnKit.lastNotification()?.message ?? '',
            /did not come from the ColumnKit releases page/
        );
    });

    test('reports a download that could not be fetched', async () => {
        const columnKit = await api();
        const decision = decide('0.1.0', release(), undefined);
        assert.ok(decision);
        await columnKit.installUpdate(decision, async () => undefined);
        assert.match(columnKit.lastNotification()?.message ?? '', /could not be downloaded/);
    });
});
