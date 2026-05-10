# PHPantom for VS Code and Cursor

[PHPantom](https://github.com/AJenbo/phpantom_lsp) is a fast PHP language server written in Rust. This extension starts `phpantom_lsp` automatically for PHP files in VS Code-compatible editors, including Cursor.

On first activation, the extension looks for a server binary in this order:

1. `phpantom.serverPath`
2. `phpantom_lsp` on `PATH` (`phpantom_lsp.exe` on Windows)
3. A cached binary in the extension global storage
4. A GitHub Releases download from `AJenbo/phpantom_lsp`, when `phpantom.autoDownload` is enabled

When `phpantom.releaseTag` is `latest`, the extension also checks for newer PHPantom releases in the background on startup and periodically while active. If a newer downloaded binary becomes available, PHPantom restarts automatically so the new server is used. Background updates are skipped when `phpantom.serverPath` is set, `phpantom.autoDownload` is disabled, `phpantom.autoUpdate` is disabled, or a `phpantom_lsp` binary on `PATH` has priority.

The language server communicates over stdio and attaches to files with language ID `php`.

## Cursor

Once published, install PHPantom from Open VSX in Cursor's Extensions view.

For a local package:

1. Run `npm install` in this directory.
2. Run `npm run package`.
3. In Cursor, run `Extensions: Install from VSIX...`.
4. Select the generated `.vsix` file.

## VS Code

Install the generated `.vsix` with `Extensions: Install from VSIX...`, or install from the marketplace if PHPantom is published there in the future.

## Configuration

`phpantom.serverPath`

Absolute path to a custom `phpantom_lsp` binary. When set, this overrides PATH lookup and downloads.

`phpantom.releaseTag`

GitHub release tag to download. The default is `latest`, which uses the latest stable GitHub release.

`phpantom.autoDownload`

Automatically download `phpantom_lsp` when no configured or PATH binary is available. Enabled by default.

`phpantom.autoUpdate`

Automatically check for newer downloaded `phpantom_lsp` releases when `phpantom.releaseTag` is `latest`. Enabled by default. Ignored when `phpantom.serverPath` is set.

`phpantom.updateCheckIntervalHours`

How often to check for newer PHPantom language server releases while the extension is active. The extension also checks once on startup without blocking activation. Defaults to `24`.

`phpantom.trace.server`

Controls Language Server Protocol tracing. Values are `off`, `messages`, and `verbose`.

## Commands

- `PHPantom: Restart Language Server`
- `PHPantom: Show Output`
- `PHPantom: Download Language Server`
- `PHPantom: Clear Downloaded Language Server`

## Troubleshooting

If the binary download fails, open the `PHPantom` output channel. The error lists the release tag, platform, expected asset names, and available assets when GitHub returns a release. You can also download a binary from the PHPantom GitHub Releases page and set `phpantom.serverPath`.

If your platform is unsupported, build `phpantom_lsp` from source and point `phpantom.serverPath` at the local binary.

If diagnostics appear twice, another PHP language server such as Intelephense, Phpactor, or PHP Tools may also be active. Disable the duplicate PHP LSP extension for the workspace.

To use a local binary, build PHPantom from source or download a release manually, then set `phpantom.serverPath` to the absolute path of `phpantom_lsp` or `phpantom_lsp.exe`.

## Security

Downloaded binaries come from [AJenbo/phpantom_lsp](https://github.com/AJenbo/phpantom_lsp) GitHub Releases. The extension verifies release asset size and verifies GitHub SHA-256 digests when GitHub publishes them. If upstream publishes standalone checksum files in the future, the extension should verify those checksums as well.
