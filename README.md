# PHPantom

PHP language support for Visual Studio Code powered by [PHPantom](https://github.com/PHPantom-dev/phpantom_lsp), a fast language server with deep type intelligence, generics, and framework-awarness.

## Features

- **Code completion.** Type-aware suggestions for symbols, keywords, and members with automatic use declaration insertion.
- **Signature help.** Parameter hints for constructors, methods, and functions.
- **Navigation.** Go to definition, type definition, implementation, find all references, and rename.
- **Diagnostics.** Undefined symbols, type errors, argument count mismatches, deprecated usage, unused imports, and implementation errors.
- **Hover.** Type information and PHPDoc documentation.
- **Code actions.** Extract variable/method/constant, inline variable, generate constructor/getters/setters, implement interface methods, auto-import, and PHPDoc generation.
- **Call hierarchy and type hierarchy.**
- **Semantic tokens, inlay hints, and code lens.**
- **Document highlight and workspace symbol search.**
- **Formatting.** PSR-12 compatible, with optional Laravel Pint integration.
- **Code folding and smart selection.**
- **Document links** for include/require paths.
- **Deep type intelligence.** Generics (`@template`), PHPStan/Psalm annotations, and framework-aware analysis including Laravel Eloquent.
- **Blade templates.** Completion, diagnostics, and navigation in `.blade.php` files, with VS Code's native HTML completion and Emmet still active in the markup.
- **Log viewer.** A panel that tails `storage/logs/*.log` with log-level highlighting and click-through on stack-trace frames. A status bar item shows a subtle dot when a log changes since you last looked.
- **Artisan command runner.** Browse your application's artisan commands in a quick-pick, fill in their arguments and options, and run them in the integrated terminal.
- **Model annotations.** Generate `@property` docblocks on your Eloquent models from the live database schema, honouring `$casts`, so column access is fully typed. A one-time boot you trigger; the language server itself stays purely static.

![PHPantom showing hover and completion on a Laravel query](https://raw.githubusercontent.com/PHPantom-dev/phpantom_vsix/master/assets/hover-compleation.png)

## Quick Start

1. Disable the built-in VS Code PHP Language Features.
   - Go to `Extensions`.
   - Search for `@builtin php`.
   - Disable `PHP Language Features`. Leave `PHP Language Basics` enabled for syntax highlighting.
2. Disable other PHP language servers (Intelephense, Phpactor, PHP Tools) to avoid duplicate content.
3. Open a PHP project. PHPantom downloads and starts the language server automatically.

To use a custom binary, set `phpantom.serverPath` to the path of your `phpantom_lsp` binary. You can build from source with `cargo install phpantom_lsp` or download a release from [GitHub](https://github.com/PHPantom-dev/phpantom_lsp/releases).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `phpantom.serverPath` | `""` | Path to a custom `phpantom_lsp` binary. |
| `phpantom.phpPath` | `""` | PHP executable used to run artisan commands. Empty uses `php` on `PATH`. |
| `phpantom.releaseTag` | `"latest"` | GitHub release tag to download. |
| `phpantom.autoDownload` | `true` | Automatically download the server if not found. |
| `phpantom.autoUpdate` | `true` | Check for newer releases periodically. |
| `phpantom.updateCheckIntervalHours` | `24` | How often to check for updates (1-168 hours). |
| `phpantom.trace.server` | `"off"` | Trace communication with the language server. |

## Commands

- **PHPantom: Restart Language Server.** Restart the language server.
- **PHPantom: Show Output.** Open the PHPantom output channel.
- **PHPantom: Show Server Version.** Display the running server version.
- **PHPantom: Check for Server Update.** Check for a newer server binary.
- **PHPantom: Clear Downloaded Language Server.** Remove cached server binaries.
- **PHPantom: Show Logs.** Open the log viewer for `storage/logs/*.log`.
- **PHPantom: Run Artisan Command.** Pick an artisan command, fill in its arguments and options, and run it in the terminal.
- **PHPantom: Generate Model Annotations.** Boot the app once to read your Eloquent models' column types from the database and write them as `@property` docblocks.
- **PHPantom: Regenerate Model Annotations.** Refresh existing model annotations after migrations, without prompting.

## How It Works

On activation the extension locates a server binary in this order:

1. `phpantom.serverPath` setting
2. `phpantom_lsp` on `PATH`
3. A previously cached binary
4. Download from GitHub Releases (when `phpantom.autoDownload` is enabled)

When `phpantom.releaseTag` is `"latest"`, the extension checks for updates on startup and periodically while active. A status bar item shows the server state.

## Troubleshooting

If the download fails, open the PHPantom output channel for details. You can always download a binary manually and set `phpantom.serverPath`.

If your platform is unsupported, build from source and point `phpantom.serverPath` at the result.

## License

[MIT](LICENSE)

---

See the [PHPantom language server changelog](https://github.com/PHPantom-dev/phpantom_lsp/blob/main/docs/CHANGELOG.md) for improvements to type intelligence, diagnostics, and completions.
