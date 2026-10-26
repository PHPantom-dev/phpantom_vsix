import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as vscode from "vscode";
import {
    CodeActionRequest,
    CompletionRequest,
    DefinitionRequest,
    DidChangeConfigurationNotification,
    DidChangeTextDocumentNotification,
    DidCloseTextDocumentNotification,
    DidOpenTextDocumentNotification,
    DidSaveTextDocumentNotification,
    DocumentFilter,
    DocumentSelector,
    DynamicFeature,
    ExecuteCommandRequest,
    HoverRequest,
    LanguageClient,
    LanguageClientOptions,
    Protocol2CodeConverter,
    ReferencesRequest,
    RenameRequest,
    ServerOptions,
    State,
    StaticFeature,
    Trace
} from "vscode-languageclient/node";
import { enhancePhpHover } from "./hover";
import { collectIndexFilters } from "./indexFilters";
import { augmentPhpDocumentSymbols } from "./phpSymbols";
import { SharedExecuteCommandFeature } from "./serverCommands";

/**
 * The template and configuration files PHPantom reads names from (template
 * names, routes, translation keys, services, PHP classes), by the language
 * another extension serves them as and the extensions the server reads.
 * The extensions keep a file mapped to one of these languages that the
 * server would take for PHP (`phpstan.neon` as YAML, say) from being sent.
 */
const RESOURCE_DOCUMENTS = [
    { language: "twig", extensions: "twig" },
    { language: "yaml", extensions: "{yaml,yml,yaml.dist,yml.dist}" },
    { language: "xml", extensions: "{xml,xml.dist,xlf,xliff}" }
];

const RESOURCE_LANGUAGES = new Set(RESOURCE_DOCUMENTS.map(({ language }) => language));

/**
 * The requests PHPantom answers in a template or configuration file. Every
 * other feature is registered for PHP and Blade only, so VS Code never
 * offers PHPantom as the formatter, highlighter, or outline of a file
 * another extension owns.
 */
const RESOURCE_REQUESTS = new Set<string>([
    DidOpenTextDocumentNotification.method,
    DidChangeTextDocumentNotification.method,
    DidCloseTextDocumentNotification.method,
    DidSaveTextDocumentNotification.method,
    CompletionRequest.method,
    HoverRequest.method,
    DefinitionRequest.method,
    ReferencesRequest.method,
    RenameRequest.method,
    CodeActionRequest.method
]);

/**
 * The template and configuration files under `base` (any on-disk file when
 * it is undefined) a server is sent.
 */
export function resourceDocumentSelector(base: string | undefined): DocumentFilter[] {
    return RESOURCE_DOCUMENTS.map(({ language, extensions }) => ({
        scheme: "file",
        language,
        pattern: base ? `${base}/**/*.${extensions}` : `**/*.${extensions}`
    }));
}

export function isResourceLanguage(languageId: string): boolean {
    return RESOURCE_LANGUAGES.has(languageId);
}

export interface StartedClient {
    client: LanguageClient;
    serverProcess: ChildProcessWithoutNullStreams;
    folder: vscode.WorkspaceFolder | undefined;
}

/**
 * Start a PHPantom language server scoped to a single workspace folder.
 *
 * Each folder gets its own server process rooted in that folder, mirroring
 * how the Zed extension launches one server per worktree. This keeps
 * multi-root workspaces correct: a file opened from the second project is
 * resolved against the second project's index rather than the first folder's.
 *
 * When `folder` is undefined the client handles loose documents that do not
 * belong to any workspace folder (untitled buffers, and on-disk files when no
 * workspace folder is open at all). The server is spawned without a working
 * directory. Pass `matchOnDiskFiles` to also claim `file` documents; this is
 * only safe when there are no per-folder clients to conflict with.
 */
export async function startClient(
    serverPath: string,
    folder: vscode.WorkspaceFolder | undefined,
    outputChannel: vscode.OutputChannel,
    matchOnDiskFiles = false
): Promise<StartedClient> {
    let serverProcess: ChildProcessWithoutNullStreams | undefined;

    const serverOptions: ServerOptions = async () => {
        const spawned = spawn(serverPath, [], {
            cwd: folder?.uri.fsPath,
            stdio: "pipe",
            windowsHide: true
        });

        if (!spawned.pid) {
            throw new Error(`Launching PHPantom language server failed: ${serverPath}`);
        }

        serverProcess = spawned;
        spawned.stderr.on("data", (data: Buffer | string) => {
            outputChannel.append(typeof data === "string" ? data : data.toString("utf8"));
        });

        return {
            reader: spawned.stdout,
            writer: spawned.stdin
        };
    };

    // Scope the per-folder client to documents inside that folder so each
    // server only receives the files it owns. The folderless client only
    // claims untitled buffers, leaving on-disk files to their folder client.
    let documentSelector: DocumentSelector;
    if (folder) {
        // Forward slashes so the glob matches on Windows too.
        const base = folder.uri.fsPath.replace(/\\/g, "/");
        const pattern = `${base}/**/*`;
        documentSelector = [
            { scheme: "file", language: "php", pattern },
            { scheme: "file", language: "blade", pattern },
            ...resourceDocumentSelector(base)
        ];
    } else if (matchOnDiskFiles) {
        documentSelector = [
            { scheme: "untitled", language: "php" },
            { scheme: "file", language: "php" },
            { scheme: "file", language: "blade" },
            ...resourceDocumentSelector(undefined)
        ];
    } else {
        documentSelector = [{ scheme: "untitled", language: "php" }];
    }

    const clientOptions: LanguageClientOptions = {
        documentSelector,
        workspaceFolder: folder,
        outputChannel,
        traceOutputChannel: outputChannel,
        synchronize: {
            configurationSection: "phpantom"
        },
        // Hand the server this folder's `files.exclude`/`files.associations`
        // before it indexes anything, so the very first scan already skips
        // what the editor hides instead of indexing it and dropping it later.
        initializationOptions: collectIndexFilters(folder),
        middleware: {
            async provideHover(document, position, token, next) {
                const hover = await next(document, position, token);
                return enhancePhpHover(document, position, token, hover);
            },
            async provideDocumentSymbols(document, token, next) {
                const symbols = await next(document, token);
                return augmentPhpDocumentSymbols(document, symbols);
            },
            async provideCodeLenses(document, token, next) {
                const lenses = await next(document, token);
                return lenses?.map((lens) => withReferenceArguments(lens, client.protocol2CodeConverter));
            },
            async resolveCodeLens(codeLens, token, next) {
                const lens = await next(codeLens, token);
                return lens && withReferenceArguments(lens, client.protocol2CodeConverter);
            }
        }
    };

    const client = new PhpantomLanguageClient(
        "phpantom",
        "PHPantom",
        serverOptions,
        clientOptions
    );

    applyConfiguredTrace(client);
    try {
        await client.start();
    } catch (error) {
        // A start that fails part way through leaves the spawned server
        // running, so reap it rather than letting failed attempts pile up
        // orphaned processes.
        await client.dispose(1000).catch(() => undefined);
        serverProcess?.kill();
        throw error;
    }

    if (!serverProcess) {
        throw new Error("PHPantom language server started, but the server process was not captured.");
    }

    return {
        client,
        serverProcess,
        folder
    };
}

/**
 * A `LanguageClient` that shares server-advertised commands with the other
 * folders' clients instead of claiming them for itself.
 *
 * The stock execute-command feature registers every command the server
 * advertises as a global VS Code command, which fails as soon as a second
 * server starts. Swapping in `SharedExecuteCommandFeature` keeps one
 * registration per command and routes invocations to the right server.
 */
class PhpantomLanguageClient extends LanguageClient {
    public registerFeature(feature: StaticFeature | DynamicFeature<unknown>): void {
        if ("registrationType" in feature && feature.registrationType.method === ExecuteCommandRequest.method) {
            super.registerFeature(new SharedExecuteCommandFeature(this));
            return;
        }

        if ("registrationType" in feature && !RESOURCE_REQUESTS.has(feature.registrationType.method)) {
            withoutResourceDocuments(feature);
        }

        super.registerFeature(feature);
    }
}

/**
 * Turn the JSON arguments of a `editor.action.showReferences` lens into the
 * `Uri`, `Position` and `Location[]` instances the command insists on.
 *
 * The server can only send protocol JSON, and VS Code runs this command
 * straight from the lens without converting it, so clicking an "N
 * references" or "N implementations" lens would otherwise fail with
 * "argument does not match one of these constraints".
 */
function withReferenceArguments(lens: vscode.CodeLens, converter: Protocol2CodeConverter): vscode.CodeLens {
    const command = lens.command;
    if (command?.command !== "editor.action.showReferences" || command.arguments?.length !== 3) {
        return lens;
    }

    const [uri, position, locations] = command.arguments;
    if (typeof uri !== "string" || !Array.isArray(locations)) {
        return lens;
    }

    command.arguments = [
        converter.asUri(uri),
        position instanceof vscode.Position ? position : converter.asPosition(position),
        locations.map((location) => (location instanceof vscode.Location ? location : converter.asLocation(location)))
    ];
    return lens;
}

/**
 * Register `feature` for the client's PHP and Blade documents only.
 *
 * A feature registers a provider for every document the client's selector
 * matches, whatever the server answers there. A formatting provider for
 * YAML would make VS Code ask which formatter to use, even though PHPantom
 * formats nothing in it.
 */
function withoutResourceDocuments(feature: StaticFeature | DynamicFeature<unknown>): void {
    const initialize = feature.initialize.bind(feature);
    feature.initialize = (capabilities, documentSelector) =>
        initialize(
            capabilities,
            documentSelector?.filter(
                (filter) => typeof filter === "string" || !("language" in filter) || !isResourceLanguage(filter.language ?? "")
            )
        );
}

/**
 * Re-send a running server the editor's file filters after the user
 * changed `files.exclude` or `files.associations`.
 *
 * Sent explicitly rather than through `synchronize`, which can only sync
 * the extension's own `phpantom` section, and these two settings are
 * VS Code's. The server distinguishes the two notifications by whether an
 * `indexing` block is present, so this cannot clobber the other.
 */
export async function sendIndexFilters(started: StartedClient): Promise<void> {
    if (started.client.state !== State.Running) {
        return;
    }

    await started.client.sendNotification(DidChangeConfigurationNotification.type, {
        settings: collectIndexFilters(started.folder)
    });
}

export function applyConfiguredTrace(client: LanguageClient): void {
    const traceSetting = vscode.workspace
        .getConfiguration("phpantom")
        .get<string>("trace.server", "off");

    client.setTrace(toTrace(traceSetting));
}

function toTrace(value: string): Trace {
    switch (value) {
        case "messages":
            return Trace.Messages;
        case "verbose":
            return Trace.Verbose;
        default:
            return Trace.Off;
    }
}
