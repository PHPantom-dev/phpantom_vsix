import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as vscode from "vscode";
import {
    DocumentSelector,
    DynamicFeature,
    ExecuteCommandRequest,
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    StaticFeature,
    Trace
} from "vscode-languageclient/node";
import { enhancePhpHover } from "./hover";
import { augmentPhpDocumentSymbols } from "./phpSymbols";
import { SharedExecuteCommandFeature } from "./serverCommands";

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
        const pattern = `${folder.uri.fsPath.replace(/\\/g, "/")}/**/*`;
        documentSelector = [
            { scheme: "file", language: "php", pattern },
            { scheme: "file", language: "blade", pattern }
        ];
    } else if (matchOnDiskFiles) {
        documentSelector = [
            { scheme: "untitled", language: "php" },
            { scheme: "file", language: "php" },
            { scheme: "file", language: "blade" }
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
        middleware: {
            async provideHover(document, position, token, next) {
                const hover = await next(document, position, token);
                return enhancePhpHover(document, position, token, hover);
            },
            async provideDocumentSymbols(document, token, next) {
                const symbols = await next(document, token);
                return augmentPhpDocumentSymbols(document, symbols);
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

        super.registerFeature(feature);
    }
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
