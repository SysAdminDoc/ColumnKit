import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as vscode from 'vscode';
import type { ColumnKitApi } from '../extension';

/**
 * CK-25. The web extension host has no module loader and no Node builtins, so
 * the browser build is a single bundle and must never reach for one on the
 * activation path.
 *
 * Loading vscode.dev is not something this harness can do, so this proves the
 * property that actually matters instead: the bundle activates in a context
 * where `require` refuses everything except `vscode`. Anything that reached for
 * node:https, node:crypto, fs or path would throw here.
 */

/** Enough of the API surface for activate() to run, and nothing more. */
function fakeVscode(): Record<string, unknown> {
    const disposable = { dispose: () => undefined };
    const event = () => disposable;
    const statusBarItem = () => ({
        text: '',
        name: '',
        tooltip: undefined as unknown,
        command: undefined as unknown,
        accessibilityInformation: undefined as unknown,
        show: () => undefined,
        hide: () => undefined,
        dispose: () => undefined
    });
    const channel = {
        name: 'ColumnKit',
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
        warn: () => undefined,
        error: () => undefined,
        appendLine: () => undefined,
        dispose: () => undefined
    };

    return {
        version: '1.77.0',
        UIKind: { Desktop: 1, Web: 2 },
        // The whole point: the browser build must take the web path.
        env: { uiKind: 2, clipboard: { readText: async () => '', writeText: async () => undefined } },
        StatusBarAlignment: { Left: 1, Right: 2 },
        QuickPickItemKind: { Separator: -1, Default: 0 },
        ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
        MarkdownString: class {
            value: string;
            isTrusted = false;
            constructor(value = '') {
                this.value = value;
            }
        },
        Uri: { parse: (s: string) => ({ toString: () => s }), joinPath: () => ({}) },
        l10n: { t: (message: string, ...args: unknown[]) => message.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])) },
        commands: {
            registerCommand: () => disposable,
            executeCommand: async () => undefined
        },
        window: {
            state: { focused: true },
            createOutputChannel: () => channel,
            createStatusBarItem: statusBarItem,
            createQuickPick: () => ({ onDidAccept: event, onDidHide: event, show: () => undefined, dispose: () => undefined }),
            showInformationMessage: async () => undefined,
            setStatusBarMessage: () => disposable,
            onDidChangeWindowState: event,
            tabGroups: {
                all: [],
                activeTabGroup: { viewColumn: 1, tabs: [], activeTab: undefined },
                onDidChangeTabGroups: event,
                onDidChangeTabs: event
            }
        },
        workspace: {
            getConfiguration: () => ({
                get: (_key: string, fallback: unknown) => fallback,
                update: async () => undefined,
                inspect: () => undefined
            }),
            onDidChangeConfiguration: event,
            fs: { createDirectory: async () => undefined, writeFile: async () => undefined, delete: async () => undefined }
        },
        extensions: { getExtension: () => undefined }
    };
}

suite('web extension build', () => {
    const bundlePath = () =>
        path.join(
            vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit')!.extensionPath,
            'out',
            'web',
            'extension.js'
        );

    test('the manifest points at a browser build that exists', () => {
        const manifest = vscode.extensions.getExtension<ColumnKitApi>('SysAdminDoc.columnkit')!
            .packageJSON as { browser?: string; main?: string };
        assert.strictEqual(manifest.browser, './out/web/extension.js');
        assert.strictEqual(manifest.main, './out/extension.js', 'the desktop entry must survive');
        assert.ok(
            fs.existsSync(bundlePath()),
            'no web bundle on disk; run `npm run build:web` before the suite'
        );
    });

    test('it is one file, because the web host cannot load another', () => {
        const bundle = fs.readFileSync(bundlePath(), 'utf8');
        // A bundler that failed to inline would leave relative requires behind.
        assert.doesNotMatch(bundle, /require\(["']\.\.?\//, 'the bundle still requires a local file');
        assert.match(bundle, /require\(["']vscode["']\)/, 'vscode should stay external');
    });

    test('activates with no Node builtin available at all', () => {
        const bundle = fs.readFileSync(bundlePath(), 'utf8');
        const asked: string[] = [];
        const stub = fakeVscode();

        const module = { exports: {} as Record<string, unknown> };
        const context = vm.createContext({
            module,
            exports: module.exports,
            console,
            setTimeout,
            clearTimeout,
            setInterval,
            clearInterval,
            require: (id: string) => {
                asked.push(id);
                if (id === 'vscode') {
                    return stub;
                }
                // Exactly what the web worker host does.
                throw new Error(`Cannot find module '${id}'`);
            }
        });
        vm.runInContext(bundle, context, { filename: 'extension.js' });

        const activate = module.exports.activate as (c: unknown) => unknown;
        assert.strictEqual(typeof activate, 'function', 'the bundle exports no activate');

        const subscriptions: { dispose(): void }[] = [];
        const api = activate({
            subscriptions,
            globalState: { get: () => undefined, update: async () => undefined },
            workspaceState: { get: () => undefined, update: async () => undefined },
            globalStorageUri: { toString: () => 'memfs:/storage' },
            extension: { packageJSON: { version: '0.1.0' } }
        }) as ColumnKitApi;

        assert.ok(subscriptions.length > 0, 'activation registered nothing');
        assert.strictEqual(api.statusBar.contributed.length, 1, 'the Even button should be there');
        assert.deepStrictEqual(
            asked.filter(id => id !== 'vscode'),
            [],
            `the bundle reached for ${asked.filter(id => id !== 'vscode').join(', ')} on the web path`
        );

        const deactivate = module.exports.deactivate as () => void;
        deactivate();
        for (const item of subscriptions) {
            item.dispose();
        }
    });
});
