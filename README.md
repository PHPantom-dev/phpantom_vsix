# PHPantom for VS Code and Cursor

> **DEPRECATED:** This `CicerBro.phpantom` extension is deprecated. Install the official [`phpantom.phpantom`](https://open-vsx.org/extension/phpantom/phpantom) extension instead, then uninstall this one.
>
> On activation, this extension shows a warning with an **Install Official** action that runs `workbench.extensions.installExtension` for `phpantom.phpantom`, then uninstalls `CicerBro.phpantom`. This prompt matters most in Cursor, which uses Open VSX but does not surface Open VSX deprecation notices in the Extensions UI.

[PHPantom](https://github.com/AJenbo/phpantom_lsp) is a fast PHP language server written in Rust. This extension starts `phpantom_lsp` automatically for PHP files in VS Code-compatible editors, including Cursor.

On first activation, the extension looks for a server binary in this order:

1. `phpantom.serverPath`
2. `phpantom_lsp` on `PATH` (`phpantom_lsp.exe` on Windows)
3. A cached binary in the extension global storage
4. A GitHub Releases download from `AJenbo/phpantom_lsp`, when `phpantom.autoDownload` is enabled

When `phpantom.releaseTag` is `latest`, the extension also checks for newer PHPantom releases in the background on startup and periodically while active. If a newer downloaded binary becomes available, PHPantom asks whether to restart the language server now or use the update later. Background updates are skipped when `phpantom.serverPath` is set, `phpantom.autoDownload` is disabled, `phpantom.autoUpdate` is disabled, or a `phpantom_lsp` binary on `PATH` has priority.

The language server communicates over stdio and attaches to files with language ID `php`. A PHPantom status bar item shows whether the server is starting, ready, checking for updates, waiting for restart, stopped, or failed. Click it to open the PHPantom output channel.

On startup, the PHPantom output channel logs the extension version, workspace path, active server source, server path, and auto-update state.

## Cursor

This `CicerBro.phpantom` listing is deprecated. Install [`phpantom.phpantom`](https://open-vsx.org/extension/phpantom/phpantom) from Open VSX in Cursor's Extensions view, then uninstall this extension. Cursor does not surface Open VSX deprecation notices in the UI, so prefer the in-editor **Install Official** prompt on activation.

For a local package of this deprecated extension:

1. Run `npm install` in this directory.
2. Run `npm run package`.
3. In Cursor, run `Extensions: Install from VSIX...`.
4. Select the generated `.vsix` file.

## VS Code

Prefer the official [`phpantom.phpantom`](https://open-vsx.org/extension/phpantom/phpantom) extension. To install this deprecated package locally, use `Extensions: Install from VSIX...`, or install from the marketplace if it is still listed.

## Configuration

`phpantom.serverPath`

Absolute path to a custom `phpantom_lsp` binary. When set, this overrides PATH lookup and downloads. Changing this setting restarts the PHPantom language server.

`phpantom.releaseTag`

GitHub release tag to download. The default is `latest`, which uses the latest stable GitHub release. Changing this setting restarts the PHPantom language server.

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
- `PHPantom: Show Server Version`
- `PHPantom: Check for Server Update`
- `PHPantom: Clear Downloaded Language Server`

## Troubleshooting

If the binary download fails, open the `PHPantom` output channel. The error lists the release tag, platform, expected asset names, and available assets when GitHub returns a release. You can also download a binary from the PHPantom GitHub Releases page and set `phpantom.serverPath`.

If your platform is unsupported, build `phpantom_lsp` from source and point `phpantom.serverPath` at the local binary.

If diagnostics appear twice, another PHP language server such as Intelephense, Phpactor, or PHP Tools may also be active. Disable the duplicate PHP LSP extension for the workspace.

To use a local binary, build PHPantom from source or download a release manually, then set `phpantom.serverPath` to the absolute path of `phpantom_lsp` or `phpantom_lsp.exe`.

## Security

Downloaded binaries come from [AJenbo/phpantom_lsp](https://github.com/AJenbo/phpantom_lsp) GitHub Releases. The extension verifies release asset size and verifies GitHub SHA-256 digests when GitHub publishes them. If upstream publishes standalone checksum files in the future, the extension should verify those checksums as well.
