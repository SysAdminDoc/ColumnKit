# ColumnKit

![version](https://img.shields.io/badge/version-0.2.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-VS%20Code%201.77%2B-lightgrey)

Status bar buttons for editor column layout. Click one, your columns snap to an even width. No shortcuts to memorise.

## Why it exists

VS Code expands an editor group the moment you click into it, but only when that group's width is exactly its minimum. The check lives in `doRestoreGroup`:

```js
let t = this.gridWidget.getViewSize(e);
(t.width === e.minimumWidth || t.height === e.minimumHeight) && this.arrangeGroups(1, e);
```

`arrangeGroups(1)` is EXPAND, and the minimum is a hardcoded 220 by 70 pixels. No setting turns this off.

The trap is that dragging a sash as far as it goes parks the column at exactly 220. So the columns you deliberately made narrow are the ones that jump to full width when you click them. A column at 221 pixels never triggers it.

ColumnKit gives you a one-click way back to an even layout that sits well clear of that floor.

## Buttons

One button, in the status bar, so the status bar has to be visible.

Clicking `Even` distributes width across every open column and leaves the column count alone. That is the everyday one, and it can never lose an arrangement.

Hover it and you get the rest: jump straight to 2, 3, 4, 6 or 8 columns, pick any count from 1 to 12, or undo the last ColumnKit change. Each is a single click. Undo only reverses changes ColumnKit made, so it won't put back a sash you dragged yourself.

The numbered actions change how many columns exist. Ask for fewer than you have open and the surplus columns' tabs get merged into the last one. Ask for more and you get empty columns. Nothing is closed and no editor is lost, but the arrangement does change, which is what undo is for. Undo brings back the widths and moves the merged tabs back to the columns they came from.

Sometimes a count isn't what you mean. `Set Active Column Width...` gives the focused column a share of the editor area, 25 through 75 percent or anything you type, and the rest of the columns take what's left. `columnkit.remainderStrategy` decides how: `even` gives them equal widths, `proportional` keeps whatever ratio they already had. A share that would push any column onto the minimum width is refused rather than applied.

Ask for more columns than the window can hold and you get as many as actually fit. Splitting past that point puts every column on the minimum width, which is the exact thing that makes them expand when you click, so the count gets capped and the message tells you what you got.

If you would rather have the numbers as permanent buttons instead of a hover menu, set `columnkit.statusBarPresets`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `columnkit.autoCorrect` | `true` | Raises every column that is sitting on its minimum width clear of it, so the expand-on-click never fires. It has to disarm all of them ahead of time, because by the time an extension hears that a group became active the editor has already expanded it. Turn it off for stock behaviour. |
| `columnkit.statusBarPresets` | `[]` | Extra numbered buttons beside `Even`. Empty by default, because the same counts are one click away in the hover menu. Setting it also brings back the picker button. |
| `columnkit.statusBarAlignment` | `left` | Which end of the status bar the buttons sit on. |
| `columnkit.showEditorTitleButton` | `false` | Adds an `Even` icon to each editor group's title bar. Off by default, because a narrow column pushes it straight into the overflow menu where it stops being one click. |
| `columnkit.checkForUpdates` | `true` | Asks GitHub once a day whether a newer release exists. See Updates below. Turn it off and ColumnKit makes no network requests at all. |
| `columnkit.rememberLayout` | `false` | Keeps this workspace's column widths and puts them back when you reopen it. Saved with the editor width it was measured at, so a layout from a wide monitor won't be restored onto a laptop. Off by default, because VS Code usually restores the grid itself. |
| `columnkit.balanceMode` | `tree` | What `Even` does on a grid. `tree` equalizes each split, `area` gives every group the same amount of space. Identical on a plain row of columns. |
| `columnkit.remainderStrategy` | `even` | How the other columns share what's left when you set one column's width. `proportional` keeps their existing ratio instead of equalising them. |
| `columnkit.watchWhileIdle` | `false` | Re-checks the widths every couple of seconds while the window has focus, which is the only way to catch a column you drag onto the minimum yourself. Off by default because it's a timer rather than a reaction to anything. |

## Commands

Everything is in the palette under `ColumnKit`, if you'd rather type than click. That matters beyond preference: the hover menu on the status bar button needs a pointer, so the palette is the keyboard route, and every action including all twelve column counts is there.

- `ColumnKit: Even Out Columns`
- `ColumnKit: Set Column Count...`
- `ColumnKit: Undo ColumnKit Change`
- `ColumnKit: Set Active Column Width...`
- `ColumnKit: Even Out This Split`
- `ColumnKit: Pin or Unpin This Column's Width`
- `ColumnKit: Copy Layout to Clipboard`
- `ColumnKit: Apply Layout from Clipboard`
- `ColumnKit: 1 Column` through `ColumnKit: 12 Columns`

## Build

```
npm install
npm run compile
npm run build:web
npm run lint
npm run package
```

There are two builds from the one source tree. `compile` produces the desktop
one, plain files under `out/`. `build:web` bundles a single file for the web
worker extension host, which has no module loader, so ColumnKit also runs in a
browser. The update check does nothing there: a browser install comes from the
Marketplace and updates itself.

That drops a `.vsix` in `dist/`, named for the version in `package.json`, alongside `SHA256SUMS.txt` and a copy of `install.cmd`.

On Windows, do not double-click the `.vsix`. Wherever Visual Studio or its Build Tools are installed, `.vsix` is registered to Visual Studio's own installer, which refuses VS Code extensions with a confusing message about selected products. Run `install.cmd` instead. It checks the file against `SHA256SUMS.txt`, refuses to go on if they disagree, and installs into every VS Code family editor it finds on your PATH.

To check a download yourself, compare it against the checksum in `SHA256SUMS.txt`, which is attached to every release beside the `.vsix`:

```
certutil -hashfile columnkit-0.2.0.vsix SHA256
```

GitHub publishes the same digest on the release asset, so the two are independent of each other:

```
gh release view v0.2.0 --json assets --jq '.assets[] | "\(.digest)  \(.name)"'
```

Or do it yourself:

```
code --install-extension dist/columnkit-*.vsix
```

## Updates

VS Code turns off auto-update for any extension installed from a `.vsix`, and that's the only way ColumnKit ships. Without something in the extension itself, you'd never hear about a fix.

So once a day it asks GitHub's releases API whether there's a newer tag. That request sends a user agent string and nothing else: no telemetry, no identifiers, nothing about your editor or your files. If there's something newer you get a notification offering the release notes, an install, or a skip that sticks for that version.

Choosing to install downloads the `.vsix`, checks it against the SHA-256 checksum GitHub publishes for that file, and stops if they don't match. A sideloaded install is never signature-checked by the editor, so that comparison is the only integrity check in the chain.

Set `columnkit.checkForUpdates` to `false` and none of it happens. That's the only network request ColumnKit ever makes.

## Other editors

The forks all carry the same bug and the same two layout commands, and they read extensions from Open VSX rather than the Marketplace. ColumnKit isn't published to either yet, so the `.vsix` from the GitHub release is the install path everywhere. Anything built on VS Code 1.77 or newer should work, which every current fork is: Cursor, VSCodium, Windsurf and Kiro all qualify comfortably. 1.77 is where `vscode.getEditorLayout` arrived, and without that command there is nothing to read.

## Known limits

A layout can be copied out as text and pasted back: `ck1:h:300,600(100,500):1f4a` is two columns with the second split in two. It's short enough to paste into a message or keep in notes. There's a checksum on the end, so a string that got wrapped or edited on the way is refused rather than half applied, and it only applies to a window that has the same number of groups open.

`Pin or Unpin This Column's Width` fixes the focused column at the width it has now. `Even` then leaves it alone and shares the space among the others, and a new editor group takes its space from them too. The pin is soft, the way Vim's `winfixwidth` is: when the window genuinely runs out of room the pinned column gives ground rather than making the layout impossible. Pins are per workspace and survive a reload, and at least one column always has to stay unpinned to take up the slack.

On a grid there are two honest answers to "even these out", and `columnkit.balanceMode` picks one. `tree` gives every split an equal share, so a plain column beside a column of two rows ends up half and half. `area` gives every editor group the same amount of space, so the same layout ends up a third and two thirds. Emacs has shipped both for years. On a plain row of columns they're identical. `Even Out This Split` is the finer version: it evens only the rows of the column you're in and leaves the column beside it untouched, the way `vertical wincmd =` does in Vim.

The numbered counts write a flat row of columns, so asking for one on a grid that has a column split into rows will flatten it. `Even` and the automatic correction both leave a grid alone.

The floor a column has to clear isn't always 220. VS Code compares a group against whatever its own editor pane asks for. Settings wants 500 and is handled. A side-by-side editor wants roughly double the normal minimum, and the extension API gives no way to tell one apart from an ordinary tab, so that case is still missed. Chat panels, terminals, notebooks and diffs all sit at 220.

Dragging a sash raises no event an extension can see, so a column you drag onto the floor yourself stays armed until the next time tabs or groups change. Toggling the side bar is just as silent, and it resizes every column. Turn on `columnkit.watchWhileIdle` if you hit this often. It re-checks on a timer while the window has focus, which is the only signal available.

## License

MIT
