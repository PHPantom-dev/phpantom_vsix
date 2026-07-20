import { execFile } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ── Reusable Artisan runner ──────────────────────────────────────────────────
//
// This module is the shared foundation for every extension feature that shells
// out to `php artisan` in the user's workspace (the Run Artisan Command
// palette entry, Laravel file generation via `make:*`, and IDE-helper style
// stub generation via `tinker`). It never feeds anything it learns back into
// the language server: running the app is a UI convenience only, per the
// extension/server boundary documented in CLAUDE.md.
//
// The two execution modes cover every caller:
//   - `runArtisanCapture` spawns artisan and returns its output, for callers
//     that consume machine-readable results (`list --format=json`, a `tinker`
//     script's JSON dump). It never throws on a non-zero exit; a broken app is
//     a normal, recoverable state that callers render as an empty result.
//   - `runArtisanInTerminal` sends the command to a reused integrated terminal,
//     for interactive or long-running commands the user should watch
//     (`migrate`, `make:*`, `queue:work`).

/** A workspace folder that contains a bootable `artisan` script. */
export interface ArtisanContext {
    /** The workspace folder whose root holds the `artisan` file. */
    folder: vscode.WorkspaceFolder;
    /** Absolute path to the `artisan` script. */
    artisanPath: string;
    /** The resolved PHP executable used to run it. */
    php: string;
}

/** The result of a captured (non-interactive) artisan run. */
export interface ArtisanResult {
    /** Standard output produced by the command. */
    stdout: string;
    /** Standard error produced by the command. */
    stderr: string;
    /**
     * The process exit code, or `null` if the process was killed by a signal
     * (e.g. a timeout). Non-zero and `null` are both "the app did not produce a
     * clean result"; callers decide how to degrade.
     */
    exitCode: number | null;
    /**
     * Set when the process could not be spawned at all (e.g. PHP not found on
     * PATH). Distinct from a non-zero exit, which means artisan ran but failed.
     */
    spawnError?: Error;
}

/** Options for a captured artisan run. */
export interface CaptureOptions {
    /** Milliseconds before the run is killed. Defaults to 60_000. */
    timeoutMs?: number;
    /**
     * Text piped to the command's stdin. Used to feed a script into
     * `artisan tinker`, which reads PHP from stdin.
     */
    stdin?: string;
}

/**
 * The PHP executable for a folder: the `phpantom.phpPath` setting (resolved
 * per-folder so multi-root workspaces can point at different runtimes), or
 * `php` on PATH when unset.
 */
export function resolvePhp(folder: vscode.WorkspaceFolder | undefined): string {
    const configured = vscode.workspace
        .getConfiguration("phpantom", folder?.uri)
        .get<string>("phpPath", "")
        .trim();
    return configured || "php";
}

/**
 * Every open workspace folder whose root contains an `artisan` script, in
 * workspace order. Empty when no Laravel application is open.
 */
export function findArtisanContexts(): ArtisanContext[] {
    const contexts: ArtisanContext[] = [];
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const artisanPath = path.join(folder.uri.fsPath, "artisan");
        if (fs.existsSync(artisanPath)) {
            contexts.push({ folder, artisanPath, php: resolvePhp(folder) });
        }
    }
    return contexts;
}

/**
 * Resolve the single Artisan context to act on. Returns the sole context
 * directly, prompts the user to choose when a multi-root workspace has more
 * than one Laravel app, and returns `undefined` when the user cancels.
 */
export async function pickArtisanContext(
    contexts: ArtisanContext[]
): Promise<ArtisanContext | undefined> {
    if (contexts.length === 1) {
        return contexts[0];
    }

    const picked = await vscode.window.showQuickPick(
        contexts.map((context) => ({
            label: context.folder.name,
            description: context.folder.uri.fsPath,
            context
        })),
        { placeHolder: "Select the Laravel application to run artisan in" }
    );
    return picked?.context;
}

/**
 * Run `php artisan <args>` in the context's folder and capture its output.
 * Never rejects: spawn failures and non-zero exits are reported through the
 * returned {@link ArtisanResult} so callers can degrade gracefully instead of
 * treating a stalled app as a hard error.
 */
export function runArtisanCapture(
    context: ArtisanContext,
    args: string[],
    options: CaptureOptions = {}
): Promise<ArtisanResult> {
    return new Promise((resolve) => {
        const child = execFile(
            context.php,
            [context.artisanPath, ...args],
            {
                cwd: context.folder.uri.fsPath,
                timeout: options.timeoutMs ?? 60_000,
                // `artisan list --format=json` and a `tinker` dump of a large
                // schema can both be sizeable; give them room before Node
                // truncates and errors.
                maxBuffer: 32 * 1024 * 1024,
                windowsHide: true
            },
            (error, stdout, stderr) => {
                const err = error as (Error & { code?: number | string }) | null;
                // ENOENT etc. from a missing PHP binary: nothing ran.
                if (err && typeof err.code === "string") {
                    resolve({ stdout, stderr, exitCode: null, spawnError: err });
                    return;
                }
                const exitCode = typeof err?.code === "number" ? err.code : 0;
                resolve({ stdout, stderr, exitCode });
            }
        );

        if (options.stdin !== undefined) {
            child.stdin?.end(options.stdin);
        }
    });
}

/**
 * The single reused terminal for interactive artisan runs, keyed by folder so
 * each Laravel app in a multi-root workspace gets its own terminal rooted at
 * the right directory.
 */
const artisanTerminals = new Map<string, vscode.Terminal>();

/**
 * Run `php artisan <args>` in a reused integrated terminal rooted at the
 * context's folder, for commands the user should watch run.
 */
export function runArtisanInTerminal(context: ArtisanContext, args: string[]): void {
    const key = context.folder.uri.toString();
    let terminal = artisanTerminals.get(key);
    if (!terminal || terminal.exitStatus !== undefined) {
        terminal = vscode.window.createTerminal({
            name:
                (vscode.workspace.workspaceFolders?.length ?? 0) > 1
                    ? `Artisan: ${context.folder.name}`
                    : "Artisan",
            cwd: context.folder.uri.fsPath
        });
        artisanTerminals.set(key, terminal);
    }

    const commandLine = [context.php, context.artisanPath, ...args].map(quoteArg).join(" ");
    terminal.show();
    terminal.sendText(commandLine);
}

/** Forget a closed terminal so a later run recreates it. */
export function disposeArtisanTerminal(terminal: vscode.Terminal): void {
    for (const [key, tracked] of artisanTerminals) {
        if (tracked === terminal) {
            artisanTerminals.delete(key);
        }
    }
}

/**
 * Quote a single command-line token for a shell. Tokens with no special
 * characters pass through untouched; anything else is wrapped so paths and
 * argument values with spaces survive `Terminal.sendText`.
 */
function quoteArg(token: string): string {
    if (token.length > 0 && /^[A-Za-z0-9_./:=@-]+$/.test(token)) {
        return token;
    }
    if (process.platform === "win32") {
        return `"${token.replace(/"/g, '""')}"`;
    }
    return `'${token.replace(/'/g, "'\\''")}'`;
}
