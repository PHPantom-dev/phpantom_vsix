import * as vscode from "vscode";
import {
    ArtisanContext,
    collectFlagOptions,
    disposeArtisanTerminal,
    findArtisanContexts,
    pickArtisanContext,
    runArtisanCapture,
    runArtisanInTerminal
} from "./artisan";

// ── V2: Run Artisan Command ──────────────────────────────────────────────────
//
// Enumerates the workspace's artisan commands via `list --format=json`, shows
// them in a quick-pick with their descriptions, prompts for the arguments and
// options declared in each command's definition, and runs the result in the
// integrated terminal. The command list is cached per folder with a manual
// refresh entry, since booting artisan to re-enumerate is slow and the set
// rarely changes within a session.

/** A positional argument declared by an artisan command. */
interface ArtisanArgument {
    /** The argument's name (used only for the prompt label). */
    name: string;
    /** Whether the command requires a value for this argument. */
    required: boolean;
    /** Whether the argument accepts multiple space-separated values. */
    array: boolean;
    /** Human-readable description, shown in the input prompt. */
    description: string;
}

/** An option (flag) declared by an artisan command. */
interface ArtisanOption {
    /** The option's long name including leading dashes, e.g. `--force`. */
    name: string;
    /** Whether the option takes a value (`--path=x`) rather than being a flag. */
    acceptValue: boolean;
    /** Whether a value is mandatory when the option is used. */
    valueRequired: boolean;
    /** Human-readable description, shown in the quick-pick. */
    description: string;
}

/** A single artisan command parsed from `list --format=json`. */
interface ArtisanCommand {
    /** The command name, e.g. `migrate` or `make:model`. */
    name: string;
    /** Short description, shown next to the name in the quick-pick. */
    description: string;
    /** Positional arguments, in declaration order. */
    arguments: ArtisanArgument[];
    /** Options, excluding Symfony's global ones (help, quiet, etc.). */
    options: ArtisanOption[];
}

// Symfony adds these to every command's definition. Hiding them keeps the
// option picker focused on what is specific to the chosen command.
const GLOBAL_OPTIONS = new Set([
    "--help",
    "--quiet",
    "--verbose",
    "--version",
    "--ansi",
    "--no-ansi",
    "--no-interaction",
    "--env"
]);

// Parsed command lists keyed by workspace-folder URI. Populated on first use
// and refreshed on demand via the quick-pick's refresh entry.
const commandCache = new Map<string, ArtisanCommand[]>();

/**
 * Register the `PHPantom: Run Artisan Command` palette command. The returned
 * disposables are owned by the extension context.
 */
export function registerArtisanCommands(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.runArtisanCommand", () =>
            runArtisanCommandPalette(outputChannel)
        ),
        vscode.window.onDidCloseTerminal((terminal) => disposeArtisanTerminal(terminal))
    );
}

/** Drive the full quick-pick → prompt → run flow. */
async function runArtisanCommandPalette(outputChannel: vscode.OutputChannel): Promise<void> {
    const contexts = findArtisanContexts();
    if (contexts.length === 0) {
        vscode.window.showInformationMessage(
            "No Laravel application was found. PHPantom looks for an artisan script in each open workspace folder."
        );
        return;
    }

    const context = await pickArtisanContext(contexts);
    if (!context) {
        return;
    }

    const command = await pickCommand(context, outputChannel);
    if (!command) {
        return;
    }

    const args = await collectArguments(command);
    if (!args) {
        return;
    }

    runArtisanInTerminal(context, [command.name, ...args]);
}

/**
 * Show the command quick-pick, loading (and caching) the list on first use.
 * A refresh entry re-enumerates by booting artisan again. Returns `undefined`
 * when the user cancels or the list cannot be loaded.
 */
async function pickCommand(
    context: ArtisanContext,
    outputChannel: vscode.OutputChannel
): Promise<ArtisanCommand | undefined> {
    let commands = await loadCommands(context, outputChannel, false);
    if (!commands) {
        return undefined;
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        const refreshItem: vscode.QuickPickItem = {
            label: "$(refresh) Refresh command list",
            alwaysShow: true
        };
        const items: (vscode.QuickPickItem & { command?: ArtisanCommand })[] = [
            refreshItem,
            ...commands.map((command) => ({
                label: command.name,
                description: command.description,
                command
            }))
        ];

        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: "Select an artisan command to run",
            matchOnDescription: true
        });
        if (!picked) {
            return undefined;
        }
        if (picked === refreshItem) {
            const refreshed = await loadCommands(context, outputChannel, true);
            if (!refreshed) {
                return undefined;
            }
            commands = refreshed;
            continue;
        }
        return picked.command;
    }
}

/**
 * Return the cached command list for the folder, or enumerate it by running
 * `list --format=json`. Surfaces a helpful message (and logs details) when the
 * app cannot boot, and returns `undefined` in that case.
 */
async function loadCommands(
    context: ArtisanContext,
    outputChannel: vscode.OutputChannel,
    forceRefresh: boolean
): Promise<ArtisanCommand[] | undefined> {
    const key = context.folder.uri.toString();
    if (!forceRefresh) {
        const cached = commandCache.get(key);
        if (cached) {
            return cached;
        }
    }

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Loading artisan commands…" },
        () => runArtisanCapture(context, ["list", "--format=json"])
    );

    if (result.spawnError) {
        vscode.window.showErrorMessage(
            `PHPantom could not run PHP (${context.php}). Set phpantom.phpPath to a PHP executable, or install PHP on your PATH.`
        );
        outputChannel.appendLine(`Artisan list failed to spawn: ${result.spawnError.message}`);
        return undefined;
    }

    if (result.exitCode !== 0) {
        vscode.window.showWarningMessage(
            "PHPantom could not list artisan commands. The application may have failed to boot. See the PHPantom output for details."
        );
        outputChannel.appendLine(
            `Artisan list exited with code ${result.exitCode ?? "signal"}:\n${result.stderr || result.stdout}`
        );
        return undefined;
    }

    const commands = parseCommands(result.stdout);
    if (!commands) {
        vscode.window.showWarningMessage(
            "PHPantom could not parse the artisan command list. See the PHPantom output for details."
        );
        outputChannel.appendLine(`Unexpected artisan list output:\n${result.stdout.slice(0, 2000)}`);
        return undefined;
    }

    commandCache.set(key, commands);
    return commands;
}

/** Parse the JSON emitted by `list --format=json` into our command model. */
function parseCommands(stdout: string): ArtisanCommand[] | undefined {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout);
    } catch {
        return undefined;
    }

    const rawCommands = (parsed as { commands?: unknown }).commands;
    if (!Array.isArray(rawCommands)) {
        return undefined;
    }

    const commands: ArtisanCommand[] = [];
    for (const raw of rawCommands) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }
        const record = raw as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : undefined;
        if (!name) {
            continue;
        }
        const definition = (record.definition ?? {}) as Record<string, unknown>;
        commands.push({
            name,
            description: typeof record.description === "string" ? record.description : "",
            arguments: parseArguments(definition.arguments),
            options: parseOptions(definition.options)
        });
    }

    commands.sort((a, b) => a.name.localeCompare(b.name));
    return commands;
}

/** Parse the `definition.arguments` map into an ordered argument list. */
function parseArguments(raw: unknown): ArtisanArgument[] {
    if (typeof raw !== "object" || raw === null) {
        return [];
    }
    const args: ArtisanArgument[] = [];
    for (const value of Object.values(raw as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) {
            continue;
        }
        const record = value as Record<string, unknown>;
        args.push({
            name: typeof record.name === "string" ? record.name : "",
            required: record.is_required === true,
            array: record.is_array === true,
            description: typeof record.description === "string" ? record.description : ""
        });
    }
    return args;
}

/** Parse the `definition.options` map, dropping Symfony's global options. */
function parseOptions(raw: unknown): ArtisanOption[] {
    if (typeof raw !== "object" || raw === null) {
        return [];
    }
    const options: ArtisanOption[] = [];
    for (const value of Object.values(raw as Record<string, unknown>)) {
        if (typeof value !== "object" || value === null) {
            continue;
        }
        const record = value as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "";
        if (!name.startsWith("--") || GLOBAL_OPTIONS.has(name)) {
            continue;
        }
        options.push({
            name,
            acceptValue: record.accept_value === true,
            valueRequired: record.is_value_required === true,
            description: typeof record.description === "string" ? record.description : ""
        });
    }
    return options;
}

/**
 * Prompt for the command's arguments and options and assemble the token list
 * passed to artisan. Returns `undefined` if the user cancels a required prompt.
 */
async function collectArguments(command: ArtisanCommand): Promise<string[] | undefined> {
    const tokens: string[] = [];

    for (const argument of command.arguments) {
        const label = argument.name || "argument";
        const suffix = argument.array ? " (space separated)" : "";
        const value = await vscode.window.showInputBox({
            title: `artisan ${command.name}`,
            prompt: argument.description
                ? `${label}: ${argument.description}${suffix}`
                : `Value for ${label}${suffix}`,
            placeHolder: argument.required ? `${label} (required)` : `${label} (optional, leave empty to skip)`,
            ignoreFocusOut: true,
            validateInput: (input) =>
                argument.required && input.trim() === "" ? `${label} is required.` : undefined
        });
        if (value === undefined) {
            return undefined;
        }
        const trimmed = value.trim();
        if (trimmed === "") {
            continue;
        }
        if (argument.array) {
            tokens.push(...tokenize(trimmed));
        } else {
            tokens.push(trimmed);
        }
    }

    const optionTokens = await collectOptions(command);
    if (optionTokens === undefined) {
        return undefined;
    }
    tokens.push(...optionTokens);

    return tokens;
}

/**
 * Let the user toggle the command's options via the shared flag picker,
 * prompting for a value on options that take one. Returns `undefined` on
 * cancellation of a required value prompt.
 */
function collectOptions(command: ArtisanCommand): Promise<string[] | undefined> {
    return collectFlagOptions(
        `artisan ${command.name}`,
        command.options.map((option) => ({
            flag: option.name,
            acceptValue: option.acceptValue,
            valueRequired: option.valueRequired,
            description: option.description
        }))
    );
}

/**
 * Split a whitespace-separated input into tokens, honouring single and double
 * quotes so array-argument values containing spaces survive intact.
 */
function tokenize(input: string): string[] {
    const tokens: string[] = [];
    const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
        tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
    }
    return tokens;
}
