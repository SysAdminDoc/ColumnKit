/**
 * Update checking for a VSIX-only install.
 *
 * VS Code disables auto-update for extensions installed from a `.vsix`, and
 * ColumnKit ships nowhere else, so without this nobody ever receives a fix.
 *
 * Kept free of the vscode module so the comparison and scheduling rules can be
 * unit-tested, and the one network call is injected so no test ever reaches
 * GitHub.
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
 * The `.vsix` in a release, but only when GitHub published a digest for it.
 *
 * Without a digest there is nothing to check a download against, and installing
 * an unverified binary is worse than telling the user to fetch it themselves.
 */
export function pickVsix(release: Release): UpdateAsset | undefined {
    const asset = release.assets.find(a => a.name.toLowerCase().endsWith('.vsix'));
    if (!asset) {
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
    release: Release | undefined,
    skippedVersion: string | undefined
): UpdateDecision | undefined {
    if (!release) {
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
