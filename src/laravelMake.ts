import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    ArtisanContext,
    collectFlagOptions,
    disposeArtisanTerminal,
    FlagOption,
    findArtisanContexts,
    pickArtisanContext,
    runArtisanCapture
} from "./artisan";
import { appRootNamespace, directoryToNamespace, fqnToFilePath, loadPsr4Roots } from "./composer";

// ── V3: Laravel file generation ──────────────────────────────────────────────
//
// A `New Laravel Class…` entry (palette and explorer folder context menu) that
// generates a file via `artisan make:*`. The user picks a generator (model,
// controller, request, …), types a name, optionally toggles the generator's
// common flags, and PHPantom runs the command and opens the file it creates.
//
// Invoked from an explorer folder, the name prompt is pre-filled with the
// clicked directory's namespace (mapped through composer.json's PSR-4 roots) so
// the class lands where the user clicked. When artisan cannot boot (no PHP, a
// broken checkout), the common kinds fall back to bundled stub files written
// straight to disk. Running artisan is sanctioned editor tooling per the
// extension/server boundary in CLAUDE.md; nothing it learns reaches the server.

/** A single `artisan make:*` generator offered in the picker. */
interface MakeGenerator {
    /** The artisan command name, e.g. `make:model`. */
    command: string;
    /** Short label shown in the quick-pick (the artisan class kind). */
    label: string;
    /** One-line description of what the generator produces. */
    description: string;
    /** Placeholder shown in the name prompt, illustrating the expected form. */
    placeholder: string;
    /**
     * Whether the name carries a namespace. Migrations (snake_case names, a
     * fixed directory) do not, so they are never namespace pre-filled.
     */
    namespaced: boolean;
    /**
     * The default sub-namespace under the app root the generator targets (e.g.
     * `Models`), used to resolve the expected file path when artisan does not
     * print it and by the bundled-template fallback. Omitted for kinds that
     * generate at the app root or outside it.
     */
    subNamespace?: string;
    /** The generator's common flags, offered before the run (see the roadmap). */
    options?: FlagOption[];
    /**
     * Renders a bundled stub for the kind, used when artisan cannot boot. Only
     * the common kinds carry one; the rest report that they need a working
     * Laravel install.
     */
    template?: (namespace: string, className: string) => string;
}

/** A bare toggle flag (no value). */
function flag(name: string, description: string): FlagOption {
    return { flag: name, acceptValue: false, valueRequired: false, description };
}

/** A flag that takes a value. `required` mandates a value once selected. */
function valueFlag(name: string, description: string, required: boolean): FlagOption {
    return { flag: name, acceptValue: true, valueRequired: required, description };
}

// The common Laravel generators, in rough order of how often they are reached
// for. This is a curated subset rather than the full `make:*` surface: it keeps
// the picker focused on the classes people create by hand.
const GENERATORS: MakeGenerator[] = [
    {
        command: "make:model",
        label: "Model",
        description: "Eloquent model",
        placeholder: "e.g. User or Blog/Post",
        namespaced: true,
        subNamespace: "Models",
        options: [
            flag("-m", "Also create a migration"),
            flag("-f", "Also create a factory"),
            flag("-s", "Also create a seeder"),
            flag("-c", "Also create a controller"),
            flag("--resource", "Make the generated controller a resource controller"),
            flag("--pivot", "Generate a pivot model")
        ],
        template: modelTemplate
    },
    {
        command: "make:controller",
        label: "Controller",
        description: "HTTP controller",
        placeholder: "e.g. UserController",
        namespaced: true,
        subNamespace: "Http\\Controllers",
        options: [
            flag("--resource", "Generate a resource controller"),
            flag("--api", "Generate an API resource controller (no create/edit)"),
            valueFlag("--model", "Bind a model to the resource controller", true),
            flag("--invokable", "Generate a single-method (__invoke) controller")
        ],
        template: controllerTemplate
    },
    {
        command: "make:request",
        label: "Form Request",
        description: "Form request validator",
        placeholder: "e.g. StoreUserRequest",
        namespaced: true,
        subNamespace: "Http\\Requests",
        template: requestTemplate
    },
    {
        command: "make:migration",
        label: "Migration",
        description: "Database migration",
        placeholder: "e.g. create_users_table",
        namespaced: false,
        options: [
            valueFlag("--create", "Table the migration creates", false),
            valueFlag("--table", "Table the migration alters", false)
        ]
    },
    { command: "make:job", label: "Job", description: "Queued job", placeholder: "e.g. ProcessPodcast", namespaced: true, subNamespace: "Jobs" },
    { command: "make:event", label: "Event", description: "Event class", placeholder: "e.g. OrderShipped", namespaced: true, subNamespace: "Events" },
    {
        command: "make:listener",
        label: "Listener",
        description: "Event listener",
        placeholder: "e.g. SendShipmentNotification",
        namespaced: true,
        subNamespace: "Listeners"
    },
    { command: "make:mail", label: "Mailable", description: "Mailable class", placeholder: "e.g. OrderShipped", namespaced: true, subNamespace: "Mail" },
    {
        command: "make:notification",
        label: "Notification",
        description: "Notification class",
        placeholder: "e.g. InvoicePaid",
        namespaced: true,
        subNamespace: "Notifications"
    },
    { command: "make:policy", label: "Policy", description: "Authorization policy", placeholder: "e.g. PostPolicy", namespaced: true, subNamespace: "Policies" },
    {
        command: "make:middleware",
        label: "Middleware",
        description: "HTTP middleware",
        placeholder: "e.g. EnsureTokenIsValid",
        namespaced: true,
        subNamespace: "Http\\Middleware"
    },
    {
        command: "make:command",
        label: "Console Command",
        description: "Artisan console command",
        placeholder: "e.g. SendEmails",
        namespaced: true,
        subNamespace: "Console\\Commands"
    },
    {
        command: "make:resource",
        label: "API Resource",
        description: "Eloquent API resource",
        placeholder: "e.g. UserResource",
        namespaced: true,
        subNamespace: "Http\\Resources"
    },
    { command: "make:factory", label: "Factory", description: "Model factory", placeholder: "e.g. UserFactory", namespaced: true },
    { command: "make:seeder", label: "Seeder", description: "Database seeder", placeholder: "e.g. UserSeeder", namespaced: true },
    { command: "make:rule", label: "Validation Rule", description: "Custom validation rule", placeholder: "e.g. Uppercase", namespaced: true, subNamespace: "Rules" },
    { command: "make:enum", label: "Enum", description: "Enum class", placeholder: "e.g. UserStatus", namespaced: true, subNamespace: "Enums" },
    { command: "make:interface", label: "Interface", description: "Interface", placeholder: "e.g. Repository", namespaced: true },
    { command: "make:trait", label: "Trait", description: "Trait", placeholder: "e.g. HasSlug", namespaced: true },
    { command: "make:class", label: "Class", description: "Plain class", placeholder: "e.g. Support/Money", namespaced: true }
];

/**
 * Register the `PHPantom: New Laravel Class…` command. It runs from the command
 * palette and from the explorer folder context menu, where VS Code passes the
 * clicked folder's URI. The returned disposables are owned by the extension
 * context.
 */
export function registerLaravelMakeCommands(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.newLaravelClass", (uri?: vscode.Uri) =>
            runNewLaravelClass(outputChannel, uri)
        ),
        vscode.window.onDidCloseTerminal((terminal) => disposeArtisanTerminal(terminal))
    );
}

/** Drive the context → generator → name → options → run flow. */
async function runNewLaravelClass(
    outputChannel: vscode.OutputChannel,
    uri: vscode.Uri | undefined
): Promise<void> {
    const contexts = findArtisanContexts();
    if (contexts.length === 0) {
        vscode.window.showInformationMessage(
            "No Laravel application was found. PHPantom looks for an artisan script in each open workspace folder."
        );
        return;
    }

    // From the explorer menu the target folder decides the app; only prompt when
    // it does not fall inside a known Laravel app (or when run from the palette).
    const artisanContext =
        (uri ? contextForUri(contexts, uri) : undefined) ?? (await pickArtisanContext(contexts));
    if (!artisanContext) {
        return;
    }

    const generator = await pickGenerator();
    if (!generator) {
        return;
    }

    const prefill = uri && generator.namespaced ? namespacePrefill(artisanContext, uri) : undefined;

    const name = await promptForName(generator, prefill);
    if (name === undefined) {
        return;
    }

    const optionTokens = await collectGeneratorOptions(generator);
    if (optionTokens === undefined) {
        return;
    }

    await generate(artisanContext, generator, name, optionTokens, outputChannel);
}

/** Show the generator quick-pick. Returns `undefined` when the user cancels. */
async function pickGenerator(): Promise<MakeGenerator | undefined> {
    const picked = await vscode.window.showQuickPick(
        GENERATORS.map((generator) => ({
            label: generator.label,
            description: generator.command,
            detail: generator.description,
            generator
        })),
        { placeHolder: "Select the kind of Laravel class to create", matchOnDescription: true }
    );
    return picked?.generator;
}

/**
 * Prompt for the new class's name, pre-filled with a namespace when generating
 * into a specific folder. Returns the trimmed name, or `undefined` if the user
 * cancels. Rejects an empty name, and a value that is only a namespace with no
 * class name after it.
 */
async function promptForName(
    generator: MakeGenerator,
    prefill: string | undefined
): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
        title: `artisan ${generator.command}`,
        prompt: `Name for the new ${generator.description}`,
        placeHolder: generator.placeholder,
        value: prefill,
        // Put the cursor after the pre-filled namespace so the user types the class name.
        valueSelection: prefill ? [prefill.length, prefill.length] : undefined,
        ignoreFocusOut: true,
        validateInput: (input) => {
            const trimmed = input.trim();
            if (trimmed === "") {
                return "A name is required.";
            }
            if (/[\\/]$/.test(trimmed)) {
                return "Add a class name after the namespace.";
            }
            return undefined;
        }
    });
    return value?.trim() || undefined;
}

/** Collect the generator's flags via the shared option picker. */
function collectGeneratorOptions(generator: MakeGenerator): Promise<string[] | undefined> {
    if (!generator.options || generator.options.length === 0) {
        return Promise.resolve([]);
    }
    return collectFlagOptions(`artisan ${generator.command}`, generator.options);
}

/**
 * Run the generator and open what it produces. The run is captured (not sent to
 * a terminal) so the created path can be read from artisan's output and the file
 * opened. `--no-interaction` keeps a headless run from stalling on a prompt.
 * When artisan cannot run, the common kinds fall back to a bundled template.
 */
async function generate(
    context: ArtisanContext,
    generator: MakeGenerator,
    name: string,
    optionTokens: string[],
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const args = [generator.command, name, ...optionTokens, "--no-interaction"];
    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Running artisan ${generator.command}…` },
        () => runArtisanCapture(context, args)
    );

    if (result.spawnError) {
        outputChannel.appendLine(`artisan ${generator.command} failed to spawn: ${result.spawnError.message}`);
        await fallBackToTemplate(context, generator, name, outputChannel);
        return;
    }

    const output = result.stdout + result.stderr;

    if (result.exitCode !== 0) {
        outputChannel.appendLine(
            `artisan ${generator.command} exited with code ${result.exitCode ?? "signal"}:\n${output.trim()}`
        );
        if (/already exists/i.test(output)) {
            vscode.window.showWarningMessage(
                `PHPantom did not create the ${generator.label.toLowerCase()}: it already exists.`
            );
            return;
        }
        await fallBackToTemplate(context, generator, name, outputChannel);
        return;
    }

    outputChannel.appendLine(output.trim() || `artisan ${generator.command} ${name} completed.`);

    const created = parseCreatedPath(output, context) ?? resolveExpectedPath(context, generator, name);
    if (created && fs.existsSync(created)) {
        await openCreatedFile(created);
    } else {
        vscode.window.showInformationMessage(`artisan ${generator.command} completed. See the PHPantom output for details.`);
    }
}

/**
 * Generate the file from a bundled stub because artisan could not run. Only the
 * common kinds carry a template; the rest report that they need a working
 * Laravel install. Never overwrites an existing file.
 */
async function fallBackToTemplate(
    context: ArtisanContext,
    generator: MakeGenerator,
    name: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const kind = generator.label.toLowerCase();

    if (!generator.template) {
        vscode.window.showWarningMessage(
            `PHPantom could not run artisan to create the ${kind}, and this kind has no offline template. It can only be generated by a working Laravel installation. See the PHPantom output for details.`
        );
        return;
    }

    const filePath = resolveExpectedPath(context, generator, name);
    if (!filePath) {
        vscode.window.showWarningMessage(
            `PHPantom could not determine where to create the ${kind}. Check the composer.json PSR-4 autoload configuration.`
        );
        return;
    }
    if (fs.existsSync(filePath)) {
        vscode.window.showWarningMessage(`${path.basename(filePath)} already exists.`);
        return;
    }

    const { namespace, className } = splitFqn(fqnFromPath(context, filePath) ?? name);
    try {
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(filePath, generator.template(namespace, className), "utf8");
    } catch (error) {
        vscode.window.showErrorMessage(`PHPantom could not write ${filePath}.`);
        outputChannel.appendLine(`Template generation failed: ${formatError(error)}`);
        return;
    }

    outputChannel.appendLine(`Created ${filePath} from a bundled template because artisan was unavailable.`);
    await openCreatedFile(filePath);
    vscode.window.showInformationMessage(
        `artisan could not run, so PHPantom created the ${kind} from a bundled template.`
    );
}

// ── Path and namespace resolution ────────────────────────────────────────────

/** The Laravel app whose folder contains `uri`, or `undefined` when none does. */
function contextForUri(contexts: ArtisanContext[], uri: vscode.Uri): ArtisanContext | undefined {
    const target = uri.fsPath;
    let best: ArtisanContext | undefined;
    for (const context of contexts) {
        const root = context.folder.uri.fsPath;
        const relative = path.relative(root, target);
        const inside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
        if (inside && (!best || root.length > best.folder.uri.fsPath.length)) {
            best = context;
        }
    }
    return best;
}

/**
 * The namespace to pre-fill the name prompt with for a clicked folder, as a
 * fully-qualified prefix ending in a separator (e.g. `App\Models\`). Returns
 * `undefined` when the folder is outside every PSR-4 root, so the prompt is
 * left empty and artisan applies its own default namespace.
 */
function namespacePrefill(context: ArtisanContext, uri: vscode.Uri): string | undefined {
    const roots = loadPsr4Roots(context.folder.uri.fsPath);
    const namespace = directoryToNamespace(roots, uri.fsPath);
    return namespace ? `${namespace}\\` : undefined;
}

/**
 * The file path a generated class is expected at, resolved from the entered name
 * and the generator's default namespace the way Laravel's generators qualify a
 * class. Used to open the file when artisan does not print a path, and by the
 * template fallback.
 */
function resolveExpectedPath(
    context: ArtisanContext,
    generator: MakeGenerator,
    name: string
): string | undefined {
    if (!generator.namespaced) {
        return undefined;
    }
    const roots = loadPsr4Roots(context.folder.uri.fsPath);
    const fqn = qualifyName(roots, context.folder.uri.fsPath, generator, name);
    return fqnToFilePath(roots, fqn);
}

/**
 * Qualify an entered name into a fully-qualified class, mirroring Laravel's
 * `qualifyClass`: a name already under the app root namespace is used verbatim
 * (this is what the folder pre-fill produces), otherwise the generator's default
 * sub-namespace is prepended.
 */
function qualifyName(
    roots: ReturnType<typeof loadPsr4Roots>,
    folderFsPath: string,
    generator: MakeGenerator,
    name: string
): string {
    const normalized = name.replace(/^[\\/]+/, "").split("/").join("\\");
    const root = appRootNamespace(roots, folderFsPath);
    if (normalized === root || normalized.startsWith(`${root}\\`)) {
        return normalized;
    }
    const base = generator.subNamespace ? `${root}\\${generator.subNamespace}` : root;
    return `${base}\\${normalized}`;
}

/** The fully-qualified class name a file path maps back to, via the PSR-4 roots. */
function fqnFromPath(context: ArtisanContext, filePath: string): string | undefined {
    const roots = loadPsr4Roots(context.folder.uri.fsPath);
    const target = path.resolve(filePath);
    for (const root of roots) {
        const relative = path.relative(root.directory, target);
        if (relative.startsWith("..") || path.isAbsolute(relative)) {
            continue;
        }
        const withoutExt = relative.replace(/\.php$/i, "").split(path.sep).join("\\");
        return root.namespace ? `${root.namespace}\\${withoutExt}` : withoutExt;
    }
    return undefined;
}

/** Split a fully-qualified class name into its namespace and short class name. */
function splitFqn(fqn: string): { namespace: string; className: string } {
    const normalized = fqn.replace(/^\\+/, "");
    const index = normalized.lastIndexOf("\\");
    if (index === -1) {
        return { namespace: "", className: normalized };
    }
    return { namespace: normalized.slice(0, index), className: normalized.slice(index + 1) };
}

/**
 * The path artisan reports for the file it created. Modern `make:*` prints it in
 * brackets (e.g. `INFO Model [app/Models/Post.php] created successfully.`);
 * older versions print only a success line, in which case this returns
 * `undefined` and the caller resolves the path itself.
 */
function parseCreatedPath(output: string, context: ArtisanContext): string | undefined {
    const match = output.match(/\[([^\]\r\n]+\.php)\]/);
    if (!match) {
        return undefined;
    }
    const raw = match[1].trim();
    return path.isAbsolute(raw) ? raw : path.join(context.folder.uri.fsPath, raw);
}

/** Open the generated file in the editor and reveal it in the explorer. */
async function openCreatedFile(filePath: string): Promise<void> {
    const uri = vscode.Uri.file(filePath);
    try {
        const document = await vscode.workspace.openTextDocument(uri);
        await vscode.window.showTextDocument(document, { preview: false });
    } catch {
        // The file exists (checked by the caller) but could not be opened as a
        // text document; still try to reveal it below.
    }
    await vscode.commands.executeCommand("revealInExplorer", uri).then(undefined, () => undefined);
}

/** Format an unknown thrown value as a message string. */
function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ── Bundled templates (offline fallback for the common kinds) ─────────────────

/** A minimal Eloquent model, matching artisan's plain `make:model` stub. */
function modelTemplate(namespace: string, className: string): string {
    return `<?php

namespace ${namespace};

use Illuminate\\Database\\Eloquent\\Model;

class ${className} extends Model
{
    //
}
`;
}

/** A plain controller, matching artisan's default `make:controller` stub. */
function controllerTemplate(namespace: string, className: string): string {
    return `<?php

namespace ${namespace};

class ${className} extends Controller
{
    //
}
`;
}

/** A form request with the authorize/rules skeleton artisan generates. */
function requestTemplate(namespace: string, className: string): string {
    return `<?php

namespace ${namespace};

use Illuminate\\Foundation\\Http\\FormRequest;

class ${className} extends FormRequest
{
    /**
     * Determine if the user is authorized to make this request.
     */
    public function authorize(): bool
    {
        return false;
    }

    /**
     * Get the validation rules that apply to the request.
     *
     * @return array<string, \\Illuminate\\Contracts\\Validation\\ValidationRule|array<mixed>|string>
     */
    public function rules(): array
    {
        return [
            //
        ];
    }
}
`;
}
