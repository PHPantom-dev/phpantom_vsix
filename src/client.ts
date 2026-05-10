import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import * as vscode from "vscode";
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    Trace
} from "vscode-languageclient/node";
import { resolveServerBinary } from "./downloader";

export interface StartedClient {
    client: LanguageClient;
    serverPath: string;
    serverProcess: ChildProcessWithoutNullStreams;
}

export async function startClient(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
): Promise<StartedClient> {
    const serverPath = await resolveServerBinary(context, outputChannel);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    let serverProcess: ChildProcessWithoutNullStreams | undefined;

    outputChannel.appendLine(`Starting PHPantom language server: ${serverPath}`);

    const serverOptions: ServerOptions = async () => {
        const spawned = spawn(serverPath, [], {
            cwd: workspaceFolder,
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

    const clientOptions: LanguageClientOptions = {
        documentSelector: [
            {
                scheme: "file",
                language: "php"
            }
        ],
        outputChannel,
        traceOutputChannel: outputChannel,
        synchronize: {
            configurationSection: "phpantom"
        }
    };

    const client = new LanguageClient(
        "phpantom",
        "PHPantom",
        serverOptions,
        clientOptions
    );

    applyConfiguredTrace(client);
    await client.start();

    if (!serverProcess) {
        throw new Error("PHPantom language server started, but the server process was not captured.");
    }

    outputChannel.appendLine("PHPantom language server started.");

    return {
        client,
        serverPath,
        serverProcess
    };
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
