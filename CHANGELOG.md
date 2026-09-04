# Changelog

## Unreleased

### Fixed
- The column picker no longer opens with Undo selected. It sat at the top of the list, so opening the picker and pressing Enter undid a layout change instead of choosing a count. It's at the bottom now, behind a separator, and the count you already have starts selected. Counts too large for the window say so in the list rather than after you pick one.
- `Even` tells you what it did. It was the one button that finished in silence, and it never warned when the columns it produced were going to sit on the minimum width. Running it on an already-even layout also no longer adds an undo step that restores the same widths.
- The guard now notices a pane that shrinks its own column. Opening Settings in a narrow column has VS Code clamp that column to exactly 500, which is the width that makes it expand on click, and only a tab event fires. ColumnKit was listening for group changes alone and slept through it.
- A window reloaded with a column already on the minimum width no longer stays that way until you happen to open or close something. The grid is restored before any extension is running, so nothing described it; ColumnKit now takes one look on startup.
- `install.cmd` no longer refuses a perfectly good download. Run from a PowerShell 7 terminal, the Windows PowerShell it called couldn't find `Get-FileHash`, so it came back with nothing and the script reported a checksum mismatch with an empty hash. Double-clicking from Explorer worked, which made it look intermittent. It uses `certutil` now, and if a hash can't be computed at all it says so instead of blaming the file.
- A column on the minimum width is now corrected on a two-dimensional layout too. ColumnKit used to back away from any grid that had a column split into rows, because the only way it knew to write a layout would have flattened the grid. That left the expand-on-click armed on exactly the layouts people build for side-by-side work.
- Opening Keyboard Shortcuts, a Search editor, Welcome or the Extensions page in a narrow column no longer drags that column wider. All four are indistinguishable from Settings through the extension API, and only Settings is really held to a 500px minimum, so ColumnKit had been widening columns that were never at risk and moving a sash nobody touched. It now goes by the width the column actually has.
- The update check now verifies what it downloads. It used to hand the release's download URL straight to the editor, and a sideloaded install is done with no hash or signature check of any kind, so whatever sat at the other end of that URL got installed. ColumnKit fetches the file itself, compares it against the checksum GitHub published for that asset, and refuses to install when they disagree. The URL also has to be a ColumnKit release download now, so a tampered reply cannot aim it at another host or at a local file.
- A reply from GitHub that isn't a release no longer crashes the update check. A captive portal or a proxy error page served as JSON used to throw a type error into the extension host log.
- A failed update check retries on the next window instead of using up the day's one check. Starting offline used to silence the feature for 24 hours.
- Undo now puts merged tabs back in the columns they came from. It used to restore the column widths only, so undoing a merge handed back the empty columns with every merged tab still piled into one of them, which is the arrangement undo is there to recover.
- Nothing ColumnKit said was reaching screen reader users. VS Code marks the status bar as a non-announcing region, so every message went unheard. Outcomes now go to a plain notification instead whenever `editor.accessibilitySupport` is set to `on`. It has to be that explicitly; the default `auto` tells an extension nothing. There are no buttons on the notification, so it's still a toast and not a prompt.
- Asking for more columns than the window can hold no longer parks every one of them on the minimum width, which is the exact state that makes columns expand on click. The count is capped at what fits and the message says so.
- The message after a column change reports what the editor actually did rather than what was asked for, and counts only the window it wrote to. With a floating window open it used to count the groups in both.
- Changing a ColumnKit setting used to leak a handle on every rebuild of the status bar buttons, so the list grew for as long as the window stayed open.
- `npm run package` names the .vsix from the version in `package.json` instead of a hardcoded 0.1.0, so a version bump no longer produces a misnamed file.
- Screen readers announced the buttons as "split-horizontal Even" and, for the presets, just a number. Every button now has a spoken label that says what it does, and a name so you can find it again in the status bar menu after hiding it.
- The warning about columns landing on the minimum width is now measured from the real editor area instead of an assumed 1920px screen. It used to warn about layouts that fit fine on a wide monitor, and stay quiet about ones that didn't fit in a small window.
- `RESEARCH.md` and `ROADMAP.md` were being packaged into the published `.vsix`. They are now excluded.

### Added
- The floor guard. VS Code expands an editor group the moment you click into it if that group's width is exactly its minimum, and there's no setting anywhere that turns it off. ColumnKit keeps every column clear of that width so the expand never has anything to fire on. `columnkit.autoCorrect` switches it off.
- Layout undo. `ColumnKit: Undo ColumnKit Change` puts back the geometry from before the last column change and moves any merged tabs back to the columns they came from. The picker offers it too. Automatic floor corrections are left out of the history, so undo always lands on something you did.
- A daily update check, because VS Code never auto-updates an extension installed from a `.vsix`. It offers the release notes, an install or a skip. An install is checked against the checksum GitHub publishes for the file. `columnkit.checkForUpdates` turns the whole thing off, and then ColumnKit makes no network requests at all.
- `install.cmd` and `SHA256SUMS.txt` are built alongside the `.vsix` and attached to the release. Double-clicking a .vsix on Windows hands it to Visual Studio's installer, which rejects it. The script checks the download against the checksum and installs it into whichever VS Code family editors you have.
- A `ColumnKit` output channel. Automatic corrections are logged at trace level with the widths before and after, so a misfire leaves a record instead of vanishing. Raise the level with `Developer: Set Log Level`.
- An icon, so the extension is recognisable in the Extensions view.
- `extensionKind: ["ui"]`, so a Remote SSH, WSL or Codespaces window stops installing and running this on the remote host when it only ever touches local window layout. Virtual workspaces are declared supported for the same reason.
- `ColumnKit: Copy Layout to Clipboard` and `Apply Layout from Clipboard`. A layout becomes a short line of text you can paste into a message or keep with your notes. It carries a checksum, so one that got wrapped or edited on the way is refused instead of half applied, and it only goes into a window with the same number of groups open rather than quietly adding or merging columns.
- `ColumnKit: Pin or Unpin This Column's Width`. A pinned column holds its width while `Even` shares the space among the others, and a new editor group takes its space from them rather than from it. The pin gives ground when the window really runs out of room, which is what Vim's `winfixwidth` does too, because refusing to fit an editor would be worse than a column that shrank. Pins live with the workspace and survive a reload.
- `columnkit.balanceMode`. On a layout with a column split into rows, "even these out" has two defensible meanings and the built-in command only offers one. `tree` equalizes each split, so a plain column beside a split one ends up half and half. `area` gives every group the same amount of space, so that same layout ends up a third and two thirds. Emacs ships both. On a plain row of columns the two agree.
- `columnkit.rememberLayout`, off by default. With it on, this workspace's column widths are saved and put back when you reopen it. The editor width they were measured at is saved too, so a layout from a wide monitor is never restored onto a laptop screen where every column would land under its minimum. It's off by default because VS Code restores the editor grid itself in most cases.
- `ColumnKit: Even Out This Split`, which evens only the group you're in and its immediate siblings. On a grid, plain `Even` redistributes everything, so there was no way to tidy one column's rows without disturbing the column next to it.
- `ColumnKit: Set Active Column Width...`, which gives the focused column a percentage of the editor area instead of a column count. The other columns take what's left, either equally or keeping their existing ratio, set by `columnkit.remainderStrategy`. A share that would push any column onto the minimum width is refused. The command also takes the percentage as an argument, so a keybinding can jump straight to one.
- `columnkit.watchWhileIdle`, off by default. Dragging a sash raises no event an extension can see, so a column you park on the minimum width yourself goes unnoticed until something else happens. With this on, ColumnKit re-checks every couple of seconds while the window has focus. It's a timer, which is why it isn't the default.
- Support for untrusted workspaces. ColumnKit reads no workspace content, so being disabled in Restricted Mode was a pure loss.
- Extension test suite (`npm test`), with a probe that pins down how `vscode.getEditorLayout` denominates group sizes.

### Changed
- The minimum VS Code version drops from 1.100 to 1.77, which is where `vscode.getEditorLayout` arrived and so the oldest editor this can work in at all. Nothing in the extension needed 1.100.
- `Undo Layout Change` is now `Undo ColumnKit Change`. It only ever reversed ColumnKit's own changes, and the old name suggested it would put back a sash you dragged yourself.
- Every string the extension shows is ready to be translated. Manifest strings live in `package.nls.json`, the rest in `l10n/bundle.l10n.json`. Nothing changes in an English editor.
- Collapsing to a single column used to report "1 columns".
- The message when a column count gets capped now talks about the minimum width rather than "the floor", which was a term only the README explained.
- The Settings editor asks for a 500px minimum rather than the usual 220, so it was expanding on click even with the guard on. Each column is now measured against the floor its own pane asks for.
- ColumnKit now adds one status bar button instead of five. Clicking it still evens the columns; hovering it gives you the column-count presets, the picker and undo, each a single click. Set `columnkit.statusBarPresets` to get the numbered buttons back as permanent items.

### Removed
- The `columnkit.minGroupWidth` setting. The minimum is a property of the pane in the column, not a number you can pick, so it is now read per column instead of configured.

## 0.1.0 - 2026-09-03

Initial release.

- Status bar buttons: `Even`, presets `4` / `6` / `8`, and a column-count picker.
- Commands for every action, available in the command palette under `ColumnKit`.
- Optional `Even` icon in the editor group title bar, off by default.
- Settings for preset list, status bar side, title bar button, and the minimum-width constant.
- Transient status bar feedback after a layout change, including how many columns were merged.
