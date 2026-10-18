# PHPantom VS Code Extension — Roadmap

The language server covers analysis; this extension covers the editor
experience around it. The items below close the "but the IDE does all
the extra stuff" gap: workflow tooling that lives editor-side by
nature. Items are ordered by priority.

An important boundary: the *language server* never boots the user's
application or runs project code — that is an analysis-engine
guarantee. The *extension* is a different animal: running `artisan` in
a terminal because the user clicked "Run command" is normal editor
tooling, exactly like a test runner. Anything the extension learns by
running the app stays in the extension (UI convenience) and is never
fed back into the server's type engine.

## V5. Test runner integration

Contribute a test controller for PHPUnit/Pest: run-test code lenses
and gutter icons on test classes/methods, backed by the standard
`vendor/bin/phpunit --filter` / `vendor/bin/pest` invocations. Scope
carefully — full test-explorer trees are a large maintenance surface;
start with "run this test / run this file".

## V7. `.env` ↔ config affordances

Editor-side niceties on top of the server's existing env/config
intelligence: a code-lens on `.env` keys showing which config files
read them, and a "copy from `.env.example`" quick action when the
server reports a missing key.

## V8. Container binding & facade accessor inspector

A palette command / panel that shells out to a small `artisan
tinker` script to dump the live container's bindings (name →
resolved concrete class, singleton vs. bind) and, for facades whose
`getFacadeAccessor()` returns a string alias, the resolved concrete
class. Render as a tree/webview with click-through to the concrete
class file, and a manual refresh (the data is only true for the boot
that produced it). This is exactly the class of fact `laravel.md`'s
"Out of scope" table rules out for the language server — dynamic
container state, and facade string-alias resolution without a
`::class` accessor. The extension can take the risk of a stale panel
that the user refreshes; the server can't take the risk of a stale
diagnostic that looks like ground truth.

## V10. Server settings as VS Code settings

Expose the commonly changed `.phpantom.toml` options as `phpantom.*`
VS Code settings (PHP version, diagnostic toggles, indexing strategy),
so a user can adjust them from the settings UI without creating a file
in the project. Today the extension contributes only its own settings
(binary path, downloads, `phpPath`, trace) and forwards
`files.exclude`/`files.associations` as the `indexing` filters.

This needs server support first: the server reads only the `indexing`
section from `initializationOptions` / `workspace/didChangeConfiguration`
(`ClientIndexingOptions` in the server's `src/config.rs`). Each option
the extension exposes has to be accepted there too, with a defined
precedence against the project's `.phpantom.toml`. The project file
should win, since it is what the whole team shares, the same way the
editor-supplied file filters merge with rather than replace it.

## V11. Connect to a remote/TCP language server

The server can already speak LSP over a TCP socket (`--tcp`); the
extension only ever spawns a local binary over stdio. Add
`phpantom.remote.enabled`, `.host`, and `.port` settings (mirroring
Phpactor's `remote.*`); when enabled, build the language client from a
socket transport rather than a spawned process. This covers running
the server inside a container or on a remote host while editing
locally.

Remote mode is a single shared endpoint, so it bypasses the per-folder
server model and uses one client that matches all PHP documents (the
same exception Phpactor's extension makes).

**Caveats:** a remote server has its own filesystem view, so `rootUri`
/ workspace paths must line up with the paths the server sees (or be
remapped). Auto-download, version checks, and the per-folder rooting do
not apply in remote mode.
