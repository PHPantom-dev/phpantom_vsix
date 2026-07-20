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

## V3. Laravel file generation

The palette entry `New Laravel Class...` ships: it picks a generator
(model, controller, request, migration, job, and more) and shells out
to the matching `artisan make:*` via the shared runner. The remaining
pieces below build on that generator catalogue.

### V3a. Explorer context menu with namespace pre-fill

Add a `New Laravel Class...` entry to the explorer folder context menu
that pre-fills the name from the clicked directory's namespace, mapped
back through the project's composer.json PSR-4 roots (e.g. right-click
`app/Models/` → the model is created as `Models\<name>`). This is the
one piece that needs composer.json PSR-4 parsing, which does not exist
in the extension yet.

### V3b. Bundled-template fallback

When `artisan` cannot boot (broken checkout, no PHP), fall back to
bundled stub files written directly to disk so generation still works.
Start with the common kinds (model, controller, request) and log a
clear message for kinds that are artisan-only; matching artisan's full
`make:*` surface offline is not worth the template maintenance.

### V3c. Per-generator options

Coming from PhpStorm's Laravel Idea, users expect the common `make:*`
flags in the picker rather than typing them by hand: `make:model`
with `-m`/`-f`/`-s`/`-c`/`--resource`/`--pivot`, `make:controller`
with `--resource`/`--api`/`--model`/`--invokable`, `make:migration`
with `--create`/`--table`. Reuse the option-collection flow from the
Run Artisan Command palette so the prompts stay consistent.

### V3d. Reveal and open the generated file

After a successful `make:*`, open the newly created file in the editor
(and reveal it in the explorer). Artisan prints the path it wrote;
capture that instead of running blind in the terminal, or resolve the
expected path from the generator plus PSR-4 roots. This matches the
"create and jump straight to it" flow both PhpStorm and the Laravel VS
Code extension provide.

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
