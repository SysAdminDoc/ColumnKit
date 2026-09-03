# Changelog

## Unreleased

### Fixed
- The warning about columns landing on the minimum width is now measured from the real editor area instead of an assumed 1920px screen. It used to warn about layouts that fit fine on a wide monitor, and stay quiet about ones that didn't fit in a small window.
- `RESEARCH.md` and `ROADMAP.md` were being packaged into the published `.vsix`. They are now excluded.

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
