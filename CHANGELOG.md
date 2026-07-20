# Changelog

All notable changes to the PHPantom VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Log viewer panel that tails `storage/logs/*.log` with log-level highlighting and click-through navigation from stack-trace frames to the referenced file and line. A status bar item opens it and shows a subtle dot when a log changes since it was last viewed.
- Run Artisan Command palette entry. It lists the application's artisan commands with their descriptions, prompts for the arguments and options each command declares, and runs the result in the integrated terminal. The command list is cached per workspace with a refresh entry, and a `phpantom.phpPath` setting selects the PHP executable used to run it.

## [0.5.0] - 2026-06-03

### Added

- Blade templates (`.blade.php`) are recognised as their own language with syntax highlighting, `{{-- --}}` comment toggling, and PHPantom completion, diagnostics, and navigation. The markup is treated as an embedded document, so VS Code's built-in HTML tag/attribute completion, Emmet, and `<style>`/`<script>` handling stay active alongside PHPantom inside Blade files.
- Docblock comment continuation on Enter and outdent after single-line control-flow statements.
- Support for Windows on ARM64

### Fixed

- Multi-root workspaces now run a separate language server per workspace folder, so files in the second and later folders get correct completion, diagnostics, and navigation instead of being resolved against the first folder's project.

### Changed

- Extension is now published under the official PHPantom publisher.
- Repository links point to the PHPantom-dev GitHub organization.
- README rewritten for marketplace presentation.

## [0.3.1] - 2026-05-15

### Added

- PHP outline augmentation so named functions and methods can appear in Sticky Scroll.

## [0.3.0]

### Added

- PHPantom status bar item for server state and output-channel access.
- `PHPantom: Show Server Version` command.
- Startup summary in the PHPantom output channel.
- Prompt before restarting after a downloaded server update.
- Information message when binary resolution settings restart the language server.

### Changed

- Renamed the manual server update command to `PHPantom: Check for Server Update`.

## [0.2.1]

### Fixed

- Serialized language server lifecycle operations to prevent duplicate `phpantom_lsp` processes during overlapping startup, restart, and update checks.
- Added a restart fallback that terminates `phpantom_lsp` if it does not exit after a graceful stop timeout.
- Restart the server automatically when binary resolution settings such as `phpantom.serverPath` change.

## [0.2.0]

### Added

- Background checks for newer PHPantom language server releases when using `phpantom.releaseTag = "latest"`.
- Automatic restart after a newer downloaded server is cached.
- `phpantom.autoUpdate` and `phpantom.updateCheckIntervalHours` settings.

## [0.1.0]

### Added

- Dedicated VS Code/Cursor extension for PHPantom.
- Automatic `phpantom_lsp` discovery via `phpantom.serverPath`, PATH, local cache, and GitHub Releases download.
- Commands for restart, output, forced download, and clearing cached binaries.
