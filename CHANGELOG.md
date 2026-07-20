# Changelog

## 0.3.3 - 2026-07-20

- Marked the extension display name as `[DEPRECATED]`.
- Show a warning on activation with an **Install Official** action that installs `phpantom.phpantom`, then uninstalls `CicerBro.phpantom`.
- Documented the migration to the official extension in the README (especially for Cursor, which does not surface Open VSX deprecation notices).

## 0.3.2 - 2026-05-19

- Improved PHPDoc hover rendering for paragraph breaks, inline `{@code ...}` tags, and `@see` references.
- Fixed paragraph restoration when the description includes `@see` references before parameter tags.

## 0.3.1 - 2026-05-15

- Added PHP outline augmentation so named functions and methods can appear in Sticky Scroll.

## 0.3.0

- Added a PHPantom status bar item for server state and output-channel access.
- Added `PHPantom: Show Server Version`.
- Renamed the manual server update command to `PHPantom: Check for Server Update`.
- Added a startup summary to the PHPantom output channel.
- Prompt before restarting after a downloaded server update.
- Show an information message when binary resolution settings restart the language server.

## 0.2.1

- Serialized language server lifecycle operations to prevent duplicate `phpantom_lsp` processes during overlapping startup, restart, and update checks.
- Added a restart fallback that terminates `phpantom_lsp` if it does not exit after a graceful stop timeout.
- Restart the server automatically when binary resolution settings such as `phpantom.serverPath` change.

## 0.2.0

- Added background checks for newer PHPantom language server releases when using `phpantom.releaseTag = "latest"`.
- Added automatic restart after a newer downloaded server is cached.
- Added `phpantom.autoUpdate` and `phpantom.updateCheckIntervalHours` settings.

## 0.1.0

- Added a dedicated VS Code/Cursor extension for PHPantom.
- Added automatic `phpantom_lsp` discovery via `phpantom.serverPath`, PATH, local cache, and GitHub Releases download.
- Added commands for restart, output, forced download, and clearing cached binaries.
