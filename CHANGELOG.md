# Changelog

## Unreleased

### Fixed
- The update check now verifies what it downloads. It used to hand the release's download URL straight to the editor, and a sideloaded install is done with no hash or signature check of any kind, so whatever sat at the other end of that URL got installed. ColumnKit fetches the file itself, compares it against the checksum GitHub published for that asset, and refuses to install when they disagree. The URL also has to be a ColumnKit release download now, so a tampered reply cannot aim it at another host or at a local file.
- A reply from GitHub that isn't a release no longer crashes the update check. A captive portal or a proxy error page served as JSON used to throw a type error into the extension host log.
- A failed update check retries on the next window instead of using up the day's one check. Starting offline used to silence the feature for 24 hours.
- Undo now puts merged tabs back in the columns they came from. It used to restore the column widths only, so undoing a merge handed back the empty columns with every merged tab still piled into one of them, which is the arrangement undo is there to recover.
- Nothing ColumnKit said was reaching screen reader users. VS Code marks the status bar as a non-announcing region, so every message went unheard. With screen reader mode on, outcomes are now delivered as a plain notification instead. There are no buttons on it, so it is still a toast and not a prompt.
- Asking for more columns than the window can hold no longer parks every one of them on the minimum width, which is the exact state that makes columns expand on click. The count is capped at what fits and the message says so.
- The message after a column change reports what the editor actually did rather than what was asked for, and counts only the window it wrote to. With a floating window open it used to count the groups in both.
- Changing a ColumnKit setting used to leak a handle on every rebuild of the status bar buttons, so the list grew for as long as the window stayed open.
- `npm run package` names the .vsix from the version in `package.json` instead of a hardcoded 0.1.0, so a version bump no longer produces a misnamed file.
- Screen readers announced the buttons as "split-horizontal Even" and, for the presets, just a number. Every button now has a spoken label that says what it does, and a name so you can find it again in the status bar menu after hiding it.
- The warning about columns landing on the minimum width is now measured from the real editor area instead of an assumed 1920px screen. It used to warn about layouts that fit fine on a wide monitor, and stay quiet about ones that didn't fit in a small window.
- `RESEARCH.md` and `ROADMAP.md` were being packaged into the published `.vsix`. They are now excluded.

### Added
- `install.cmd` and `SHA256SUMS.txt` ship with the release. Double-clicking a .vsix on Windows hands it to Visual Studio's installer, which rejects it; the script checks the download against the checksum and installs it properly into whichever VS Code family editors you have.
- A `ColumnKit` output channel. Automatic corrections are logged at trace level with the widths before and after, so a misfire leaves a record instead of vanishing. Raise the level with `Developer: Set Log Level`.
- An icon, so the extension is recognisable in the Extensions view.
- `extensionKind: ["ui"]`, so a Remote SSH, WSL or Codespaces window stops installing and running this on the remote host when it only ever touches local window layout. Virtual workspaces are declared supported for the same reason.

### Removed
- The `columnkit.minGroupWidth` setting. The minimum is a property of the pane in the column, not a number you can pick, so it is now read per column instead of configured.

### Changed
- The Settings editor asks for a 500px minimum rather than the usual 220, so it was expanding on click even with the guard on. Each column is now measured against the floor its own pane asks for.
- ColumnKit now adds one status bar button instead of five. Clicking it still evens the columns; hovering it gives you the column-count presets, the picker and undo, each a single click. Set `columnkit.statusBarPresets` to get the numbered buttons back as permanent items.

### Added
- Layout undo. `ColumnKit: Undo Layout Change` puts back the geometry from before the last column change, and the picker offers it too. Automatic floor corrections are left out of the history, so undo always lands on something you did.
- Extension test suite (`npm test`), with a probe that pins down how `vscode.getEditorLayout` denominates group sizes.

## 0.1.0 - 2026-09-03

Initial release.

- Status bar buttons: `Even`, presets `4` / `6` / `8`, and a column-count picker.
- Commands for every action, available in the command palette under `ColumnKit`.
- Optional `Even` icon in the editor group title bar, off by default.
- Settings for preset list, status bar side, title bar button, and the minimum-width constant.
- Transient status bar feedback after a layout change, including how many columns were merged.
