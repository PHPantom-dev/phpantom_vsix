# Changelog

All notable changes to the PHPantom VS Code extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

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
