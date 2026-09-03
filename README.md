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

They appear in the status bar, so the status bar has to be visible.

| Button | What it does |
|---|---|
| `Even` | Distributes width across every open column and leaves the column count alone. This is the safe one. |
| `4` `6` `8` | Snaps to that many equal columns. |
| Layout icon | Opens a picker for any count from 1 to 12. |

The numbered buttons change how many columns exist. Ask for fewer than you have open and the surplus columns' tabs get merged into the last one. Ask for more and you get empty columns. Nothing is closed and no editor is lost, but the arrangement does change. `Even` never touches the count.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `columnkit.autoCorrect` | `true` | Raises the active column clear of the 220px floor as it becomes active, so the expand-on-click never fires. Turn it off for stock behaviour. |
| `columnkit.statusBarPresets` | `[4, 6, 8]` | Which numbered buttons to show. Set it to `[]` for just `Even` and the picker. |
| `columnkit.statusBarAlignment` | `left` | Which end of the status bar the buttons sit on. |
| `columnkit.showEditorTitleButton` | `false` | Adds an `Even` icon to each editor group's title bar. Off by default, because a narrow column pushes it straight into the overflow menu where it stops being one click. |
| `columnkit.minGroupWidth` | `220` | The constant used to warn when a column count can't fit above the floor. Leave it alone unless a future VS Code build changes the value. |

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

That drops a `.vsix` in `dist/`. Install it with:

```
code --install-extension dist/columnkit-0.1.0.vsix
```

## Known limits

The floor a column has to clear isn't always 220. VS Code compares a group against whatever its own editor pane asks for, and a Settings tab wants 500, a side-by-side diff about 440. Those panes can still expand on click. Everything else, including chat panels and terminals, sits at 220 and is handled.

## License

MIT
