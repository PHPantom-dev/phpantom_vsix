import * as vscode from "vscode";
import {
    disposeArtisanTerminal,
    findArtisanContexts,
    pickArtisanContext,
    runArtisanInTerminal
} from "./artisan";

// ── V3: Laravel file generation ──────────────────────────────────────────────
//
// A `New Laravel Class…` palette entry that shells out to `artisan make:*`.
// The user picks a generator (model, controller, request, …), types a name,
// and PHPantom runs the command in the shared integrated terminal so they can
// watch it work and see the path artisan reports.
//
// This first slice is palette-only and always prompts for the name. Two
// follow-ups build on it: pre-filling the name/namespace from a clicked
// explorer directory, and a bundled-template fallback for when `artisan`
// cannot boot. Both reuse this generator catalogue and the shared artisan
// runner, per the extension/server boundary in CLAUDE.md.

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
}

// The common Laravel generators, in rough order of how often they are reached
// for. This is a curated subset rather than the full `make:*` surface: it keeps
// the picker focused on the classes people create by hand, and every entry
// takes a single name argument so the prompt flow is uniform.
const GENERATORS: MakeGenerator[] = [
    { command: "make:model", label: "Model", description: "Eloquent model", placeholder: "e.g. User or Blog/Post" },
    {
        command: "make:controller",
        label: "Controller",
        description: "HTTP controller",
        placeholder: "e.g. UserController"
    },
    {
        command: "make:request",
        label: "Form Request",
        description: "Form request validator",
        placeholder: "e.g. StoreUserRequest"
    },
    {
        command: "make:migration",
        label: "Migration",
        description: "Database migration",
        placeholder: "e.g. create_users_table"
    },
    { command: "make:job", label: "Job", description: "Queued job", placeholder: "e.g. ProcessPodcast" },
    { command: "make:event", label: "Event", description: "Event class", placeholder: "e.g. OrderShipped" },
    { command: "make:listener", label: "Listener", description: "Event listener", placeholder: "e.g. SendShipmentNotification" },
    { command: "make:mail", label: "Mailable", description: "Mailable class", placeholder: "e.g. OrderShipped" },
    {
        command: "make:notification",
        label: "Notification",
        description: "Notification class",
        placeholder: "e.g. InvoicePaid"
    },
    { command: "make:policy", label: "Policy", description: "Authorization policy", placeholder: "e.g. PostPolicy" },
    { command: "make:middleware", label: "Middleware", description: "HTTP middleware", placeholder: "e.g. EnsureTokenIsValid" },
    { command: "make:command", label: "Console Command", description: "Artisan console command", placeholder: "e.g. SendEmails" },
    { command: "make:resource", label: "API Resource", description: "Eloquent API resource", placeholder: "e.g. UserResource" },
    { command: "make:factory", label: "Factory", description: "Model factory", placeholder: "e.g. UserFactory" },
    { command: "make:seeder", label: "Seeder", description: "Database seeder", placeholder: "e.g. UserSeeder" },
    { command: "make:rule", label: "Validation Rule", description: "Custom validation rule", placeholder: "e.g. Uppercase" },
    { command: "make:enum", label: "Enum", description: "Enum class", placeholder: "e.g. UserStatus" },
    { command: "make:interface", label: "Interface", description: "Interface", placeholder: "e.g. Repository" },
    { command: "make:trait", label: "Trait", description: "Trait", placeholder: "e.g. HasSlug" },
    { command: "make:class", label: "Class", description: "Plain class", placeholder: "e.g. Support/Money" }
];

/**
 * Register the `PHPantom: New Laravel Class…` palette command. The returned
 * disposables are owned by the extension context.
 */
export function registerLaravelMakeCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.newLaravelClass", () => runNewLaravelClass()),
        vscode.window.onDidCloseTerminal((terminal) => disposeArtisanTerminal(terminal))
    );
}

/** Drive the generator-pick → name-prompt → run flow. */
async function runNewLaravelClass(): Promise<void> {
    const contexts = findArtisanContexts();
    if (contexts.length === 0) {
        vscode.window.showInformationMessage(
            "No Laravel application was found. PHPantom looks for an artisan script in each open workspace folder."
        );
        return;
    }

    const artisanContext = await pickArtisanContext(contexts);
    if (!artisanContext) {
        return;
    }

    const generator = await pickGenerator();
    if (!generator) {
        return;
    }

    const name = await promptForName(generator);
    if (name === undefined) {
        return;
    }

    runArtisanInTerminal(artisanContext, [generator.command, name]);
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
 * Prompt for the new class's name. Returns the trimmed name, or `undefined` if
 * the user cancels. Rejects an empty name so the run never passes a bare
 * `make:*` with no argument.
 */
async function promptForName(generator: MakeGenerator): Promise<string | undefined> {
    const value = await vscode.window.showInputBox({
        title: `artisan ${generator.command}`,
        prompt: `Name for the new ${generator.description}`,
        placeHolder: generator.placeholder,
        ignoreFocusOut: true,
        validateInput: (input) => (input.trim() === "" ? "A name is required." : undefined)
    });
    return value?.trim() || undefined;
}
