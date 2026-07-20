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

## V2. Artisan command runner

A `PHPantom: Run Artisan Command` palette command backed by a VS Code
task provider. Enumerate commands by running `php artisan list
--format=json` in the workspace (graceful empty state when the app
doesn't boot), show them in a quick-pick with their descriptions,
prompt for arguments/options declared in the command's definition,
and run in the integrated terminal. Cache the list per workspace with
a manual refresh.

## V3. Laravel file generation

`New Laravel Class...` explorer context-menu and palette entries that
shell out to `artisan make:*` (model, controller, request, migration,
job, etc.), pre-filling the name from the clicked directory's
namespace. Where `artisan` is unavailable, fall back to bundled file
templates so generation still works on a broken checkout.

## V4. Route list panel

A tree/webview panel listing the application's routes (method, URI,
name, action) with click-through navigation to the controller method.
Source the data from the language server (it already indexes route
registrations statically) via a custom LSP request rather than
`artisan route:list`, so the panel works without booting and stays
live as files change. Filter box for URI/name/action.

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

## V9. IDE-helper style stub generation commands

Palette commands ("Generate model annotations", "Generate macro
stubs", "Generate manager/driver stubs") that boot the app once —
via `artisan ide-helper:models` / `ide-helper:generate` when
`barryvdh/laravel-ide-helper` is installed, or a small bundled
tinker script otherwise — and write the result as `@property` /
`@mixin` docblocks (or a generated stub file alongside the project).
Unlike V8, the output here is a durable static artifact, not a
transient panel: PHPantom's "code-declared types win" philosophy
already treats `@property` tags as the most authoritative source, so
a one-time boot in the editor is the sanctioned way to close the
"Model column types from a live database connection", "Macro
discovery (`Macroable` trait)", and "Manager → driver resolution"
rows in `laravel.md`'s out-of-scope table — the boot happens once,
by the user's choice, and the server goes back to being purely
static on the next parse. Prompt before overwriting hand-written
annotations, and add a "regenerate" variant for after migrations
run.
