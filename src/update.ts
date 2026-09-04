/**
 * Update checking for a VSIX-only install.
 *
 * VS Code disables auto-update for extensions installed from a `.vsix`, and
 * ColumnKit ships nowhere else, so without this nobody ever receives a fix.
 *
 * Kept free of the vscode module so the comparison and scheduling rules can be
 * unit-tested. The network call itself lives in extension.ts and is injectable,
 * so no test ever reaches GitHub.
 */

/** Once a day. Often enough to matter, rare enough not to be rude. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseAsset {
    name: string;
    browser_download_url: string;
    /** "sha256:..." since 2025-06-03. Absent on older releases. */
    digest?: string | null;
}

export interface Release {
    tag_name: string;
    html_url: string;
    assets: ReleaseAsset[];
}

/**
 * Where a release asset has to live before the update path will touch it.
 *
 * The URL arrives in the same JSON body as everything else, so pinning it does
 * not defend against whoever controls that body. What it does stop is the body
 * steering a download at some unrelated host, or at a `file:` path on this
 * machine, which is a much larger surface than the one release page.
 */
export const ASSET_PREFIX = 'https://github.com/SysAdminDoc/ColumnKit/releases/download/';

/** Where the Release notes button is allowed to send a browser. */
export const RELEASE_PREFIX = 'https://github.com/SysAdminDoc/ColumnKit/';

/**
 * Whether a parsed response really is a release.
 *
 * Any 200 whose body is not the shape we expect used to reach `tag_name.trim()`
 * and throw. A captive portal, a proxy error page served as JSON, an API change
 * and an empty array all land here.
 */
export function isRelease(value: unknown): value is Release {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return false;
    }
    const release = value as Record<string, unknown>;
    if (typeof release.tag_name !== 'string' || typeof release.html_url !== 'string') {
        return false;
    }
    if (!Array.isArray(release.assets)) {
        return false;
    }
    return release.assets.every(entry => {
        if (typeof entry !== 'object' || entry === null) {
            return false;
        }
        const asset = entry as Record<string, unknown>;
        return (
            typeof asset.name === 'string' &&
            typeof asset.browser_download_url === 'string' &&
            (asset.digest === undefined || asset.digest === null || typeof asset.digest === 'string')
        );
    });
}

export function shouldCheck(lastCheckedAt: number | undefined, now: number): boolean {
    if (lastCheckedAt === undefined) {
        return true;
    }
    // A clock that moved backwards would otherwise wedge the check until the
    // original deadline came round again.
    if (lastCheckedAt > now) {
        return true;
    }
    return now - lastCheckedAt >= UPDATE_CHECK_INTERVAL_MS;
}

/** Numeric release components of a version, or undefined if it is not one. */
export function parseVersion(version: string): number[] | undefined {
    const cleaned = version.trim().replace(/^v/i, '');
    // Pre-release and build metadata are dropped: ColumnKit does not publish
    // them, and guessing at their ordering would be worse than ignoring them.
    const core = cleaned.split(/[-+]/)[0];
    const parts = core.split('.');
    if (parts.length === 0 || parts.length > 3) {
        return undefined;
    }
    const numbers = parts.map(part => (/^\d+$/.test(part) ? Number(part) : NaN));
    if (numbers.some(Number.isNaN)) {
        return undefined;
    }
    while (numbers.length < 3) {
        numbers.push(0);
    }
    return numbers;
}

export function isNewer(current: string, candidate: string): boolean {
    const a = parseVersion(current);
    const b = parseVersion(candidate);
    if (!a || !b) {
        return false;
    }
    for (let i = 0; i < 3; i++) {
        if (b[i] !== a[i]) {
            return b[i] > a[i];
        }
    }
    return false;
}

export interface UpdateAsset {
    url: string;
    /** Lowercase hex sha256, taken from the release metadata. */
    sha256: string;
}

/**
 * The `.vsix` in a release, but only when it comes from this repository's
 * release downloads and GitHub published a digest for it.
 *
 * The digest is what the downloaded bytes are checked against before anything
 * is installed. Without one there is nothing to check, so the update is offered
 * as a link instead of a one-click install.
 */
export function pickVsix(release: Release): UpdateAsset | undefined {
    const asset = release.assets.find(a => a.name.toLowerCase().endsWith('.vsix'));
    if (!asset || !asset.browser_download_url.startsWith(ASSET_PREFIX)) {
        return undefined;
    }
    const digest = asset.digest ?? '';
    const match = /^sha256:([0-9a-f]{64})$/i.exec(digest);
    if (!match) {
        return undefined;
    }
    return { url: asset.browser_download_url, sha256: match[1].toLowerCase() };
}

export interface UpdateDecision {
    /** The tag that is newer, without its leading v. */
    version: string;
    release: Release;
    asset: UpdateAsset | undefined;
}

/**
 * Whether `release` is worth telling the user about.
 *
 * A version the user has already skipped stays skipped, the way a dismissed
 * update prompt should.
 */
export function decide(
    currentVersion: string,
    release: unknown,
    skippedVersion: string | undefined
): UpdateDecision | undefined {
    if (!isRelease(release)) {
        return undefined;
    }
    if (!release.html_url.startsWith(RELEASE_PREFIX)) {
        // The notes button opens this in a browser, so it is pinned too.
        return undefined;
    }
    const version = release.tag_name.trim().replace(/^v/i, '');
    if (!isNewer(currentVersion, version)) {
        return undefined;
    }
    if (skippedVersion && parseVersion(skippedVersion) && !isNewer(skippedVersion, version)) {
        return undefined;
    }
    return { version, release, asset: pickVsix(release) };
}
