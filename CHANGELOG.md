# Changelog

## Unreleased

### Fixed
- Changing a ColumnKit setting used to leak a handle on every rebuild of the status bar buttons, so the list grew for as long as the window stayed open.
- `npm run package` names the .vsix from the version in `package.json` instead of a hardcoded 0.1.0, so a version bump no longer produces a misnamed file.
- Screen readers announced the buttons as "split-horizontal Even" and, for the presets, just a number. Every button now has a spoken label that says what it does, and a name so you can find it again in the status bar menu after hiding it.
- The warning about columns landing on the minimum width is now measured from the real editor area instead of an assumed 1920px screen. It used to warn about layouts that fit fine on a wide monitor, and stay quiet about ones that didn't fit in a small window.
- `RESEARCH.md` and `ROADMAP.md` were being packaged into the published `.vsix`. They are now excluded.

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
