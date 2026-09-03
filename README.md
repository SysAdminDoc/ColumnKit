# ColumnKit

![version](https://img.shields.io/badge/version-0.1.0-blue)
![license](https://img.shields.io/badge/license-MIT-green)
![platform](https://img.shields.io/badge/platform-VS%20Code%201.100%2B-lightgrey)

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

Hover it and you get the rest: jump straight to 2, 3, 4, 6 or 8 columns, pick any count from 1 to 12, or undo the last layout change. Each is a single click.

The numbered actions change how many columns exist. Ask for fewer than you have open and the surplus columns' tabs get merged into the last one. Ask for more and you get empty columns. Nothing is closed and no editor is lost, but the arrangement does change, which is what undo is for.

If you would rather have the numbers as permanent buttons instead of a hover menu, set `columnkit.statusBarPresets`.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `columnkit.autoCorrect` | `true` | Raises the active column clear of the 220px floor as it becomes active, so the expand-on-click never fires. Turn it off for stock behaviour. |
| `columnkit.statusBarPresets` | `[]` | Extra numbered buttons beside `Even`. Empty by default, because the same counts are one click away in the hover menu. Setting it also brings back the picker button. |
| `columnkit.statusBarAlignment` | `left` | Which end of the status bar the buttons sit on. |
| `columnkit.showEditorTitleButton` | `false` | Adds an `Even` icon to each editor group's title bar. Off by default, because a narrow column pushes it straight into the overflow menu where it stops being one click. |

## Commands

Everything is in the palette under `ColumnKit`, if you'd rather type than click.

- `ColumnKit: Even Out Columns`
- `ColumnKit: Set Column Count...`
- `ColumnKit: Undo Layout Change`
- `ColumnKit: 2 Columns` through `ColumnKit: 8 Columns`

## Build

```
npm install
npm run compile
npm run package
```

That drops a `.vsix` in `dist/`, named for the version in `package.json`. Install it with:

```
code --install-extension dist/columnkit-*.vsix
```

## Known limits

The floor a column has to clear isn't always 220. VS Code compares a group against whatever its own editor pane asks for. Settings wants 500 and is handled. A side-by-side editor wants roughly double the normal minimum, and the extension API gives no way to tell one apart from an ordinary tab, so that case is still missed. Chat panels, terminals, notebooks and diffs all sit at 220.

## License

MIT
