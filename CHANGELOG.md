# Changelog

## Unreleased

### Fixed
- `RESEARCH.md` and `ROADMAP.md` were being packaged into the published `.vsix`. They are now excluded.

### Added
- Extension test suite (`npm test`), with a probe that pins down how `vscode.getEditorLayout` denominates group sizes.

## 0.1.0 - 2026-09-03

Initial release.

- Status bar buttons: `Even`, presets `4` / `6` / `8`, and a column-count picker.
- Commands for every action, available in the command palette under `ColumnKit`.
- Optional `Even` icon in the editor group title bar, off by default.
- Settings for preset list, status bar side, title bar button, and the minimum-width constant.
- Transient status bar feedback after a layout change, including how many columns were merged.
