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
