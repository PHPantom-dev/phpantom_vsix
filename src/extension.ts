import { ChildProcessWithoutNullStreams } from "child_process";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { applyConfiguredTrace, startClient } from "./client";
import {
    checkForServerUpdate,
    clearDownloadedServer,
    downloadServer
} from "./downloader";

let client: LanguageClient | undefined;
let activeServerPath: string | undefined;
let activeServerProcess: ChildProcessWithoutNullStreams | undefined;
let outputChannel: vscode.OutputChannel;
let updateTimer: NodeJS.Timeout | undefined;
let updateCheckInProgress = false;
let lifecycleQueue: Promise<void> = Promise.resolve();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel("PHPantom");
    context.subscriptions.push(outputChannel);

    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.restartServer", async () => {
            await restartServer(context);
        }),
        vscode.commands.registerCommand("phpantom.showOutput", () => {
            outputChannel.show();
        }),
        vscode.commands.registerCommand("phpantom.downloadServer", async () => {
            await runLifecycleCommand("download PHPantom language server", async () => {
                const serverPath = await downloadServer(context, outputChannel, true);
                vscode.window.showInformationMessage(`PHPantom language server downloaded to ${serverPath}.`);
            });
        }),
        vscode.commands.registerCommand("phpantom.clearDownloadedServer", async () => {
            await runLifecycleCommand("clear downloaded PHPantom language servers", async () => {
                await stopClient();
                await clearDownloadedServer(context);
                vscode.window.showInformationMessage("Downloaded PHPantom language servers were cleared.");
            });
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("phpantom.trace.server") && client) {
                applyConfiguredTrace(client);
            }

            const serverResolutionChanged = event.affectsConfiguration("phpantom.serverPath")
                || event.affectsConfiguration("phpantom.releaseTag")
                || event.affectsConfiguration("phpantom.autoDownload");

            if (
                event.affectsConfiguration("phpantom.autoUpdate")
                || event.affectsConfiguration("phpantom.updateCheckIntervalHours")
                || serverResolutionChanged
            ) {
                scheduleServerUpdateChecks(context);
            }

            if (serverResolutionChanged) {
                void restartServer(context);
            }
        })
    );
    context.subscriptions.push(new vscode.Disposable(clearUpdateTimer));

    await runLifecycleCommand("start PHPantom language server", async () => {
        await startServer(context);
    });

    scheduleServerUpdateChecks(context);
}

export async function deactivate(): Promise<void> {
    clearUpdateTimer();
    await lifecycleQueue;
    await stopClient();
}

async function restartServer(context: vscode.ExtensionContext): Promise<void> {
    await runLifecycleCommand("restart PHPantom language server", async () => {
        outputChannel.appendLine("Restarting PHPantom language server.");
        await stopClient();
        await startServer(context);
    });
}

async function startServer(context: vscode.ExtensionContext): Promise<void> {
    if (client) {
        outputChannel.appendLine(`PHPantom language server is already running: ${activeServerPath ?? "unknown path"}`);
        return;
    }

    const started = await startClient(context, outputChannel);
    client = started.client;
    activeServerPath = started.serverPath;
    activeServerProcess = started.serverProcess;
}

async function stopClient(): Promise<void> {
    if (!client) {
        return;
    }

    const activeClient = client;
    const serverProcess = activeServerProcess;
    client = undefined;
    activeServerPath = undefined;
    activeServerProcess = undefined;

    try {
        await activeClient.stop(1000);
    } catch (error) {
        outputChannel.appendLine(`Graceful PHPantom language server stop timed out or failed: ${formatError(error)}`);
    }

    if (serverProcess) {
        await terminateServerProcess(serverProcess);
    }

    outputChannel.appendLine("PHPantom language server stopped.");
}

async function terminateServerProcess(serverProcess: ChildProcessWithoutNullStreams): Promise<void> {
    if (!isProcessRunning(serverProcess)) {
        return;
    }

    if (await waitForProcessExit(serverProcess, 1000)) {
        return;
    }

    outputChannel.appendLine("PHPantom language server did not exit after 1000ms; terminating process.");
    serverProcess.kill("SIGTERM");

    if (await waitForProcessExit(serverProcess, 500)) {
        return;
    }

    if (process.platform !== "win32") {
        outputChannel.appendLine("PHPantom language server ignored SIGTERM; forcing SIGKILL.");
        serverProcess.kill("SIGKILL");
        await waitForProcessExit(serverProcess, 500);
    }
}

function isProcessRunning(serverProcess: ChildProcessWithoutNullStreams): boolean {
    if (serverProcess.exitCode !== null || serverProcess.signalCode !== null || !serverProcess.pid) {
        return false;
    }

    try {
        process.kill(serverProcess.pid, 0);
        return true;
    } catch {
        return false;
    }
}

function waitForProcessExit(
    serverProcess: ChildProcessWithoutNullStreams,
    timeoutMs: number
): Promise<boolean> {
    if (!isProcessRunning(serverProcess)) {
        return Promise.resolve(true);
    }

    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            serverProcess.off("exit", onExit);
            resolve(false);
        }, timeoutMs);

        const onExit = () => {
            clearTimeout(timer);
            resolve(true);
        };

        serverProcess.once("exit", onExit);
    });
}

function scheduleServerUpdateChecks(context: vscode.ExtensionContext): void {
    clearUpdateTimer();

    if (!isAutomaticUpdateEnabled()) {
        return;
    }

    void runBackgroundUpdateCheck(context, "startup");

    const intervalHours = getUpdateCheckIntervalHours();
    updateTimer = setInterval(() => {
        void runBackgroundUpdateCheck(context, "scheduled");
    }, intervalHours * 60 * 60 * 1000);
}

function clearUpdateTimer(): void {
    if (!updateTimer) {
        return;
    }

    clearInterval(updateTimer);
    updateTimer = undefined;
}

async function runBackgroundUpdateCheck(
    context: vscode.ExtensionContext,
    reason: "startup" | "scheduled"
): Promise<void> {
    if (updateCheckInProgress) {
        return;
    }

    updateCheckInProgress = true;
    try {
        const result = await checkForServerUpdate(context, outputChannel);

        if (result.status === "skipped") {
            outputChannel.appendLine(`Skipping PHPantom update check: ${result.reason}.`);
            return;
        }

        if (!result.serverPath) {
            return;
        }

        if (activeServerPath === result.serverPath) {
            return;
        }

        const action = result.status === "updated"
            ? `Downloaded PHPantom language server ${result.releaseTag}.`
            : `Found cached PHPantom language server ${result.releaseTag}.`;

        outputChannel.appendLine(`${action} Restarting to use ${result.serverPath}.`);
        await restartServer(context);
    } catch (error) {
        outputChannel.appendLine(
            `Background PHPantom update check failed during ${reason}: ${formatError(error)}`
        );
    } finally {
        updateCheckInProgress = false;
    }
}

function isAutomaticUpdateEnabled(): boolean {
    const config = vscode.workspace.getConfiguration("phpantom");

    if (!config.get<boolean>("autoUpdate", true)) {
        return false;
    }

    if (!config.get<boolean>("autoDownload", true)) {
        return false;
    }

    if (config.get<string>("serverPath", "").trim()) {
        return false;
    }

    return config.get<string>("releaseTag", "latest").trim() === "latest";
}

function getUpdateCheckIntervalHours(): number {
    const configured = vscode.workspace
        .getConfiguration("phpantom")
        .get<number>("updateCheckIntervalHours", 24);

    if (!Number.isFinite(configured) || configured < 1) {
        return 24;
    }

    return Math.min(configured, 168);
}

async function runCommand(description: string, task: () => Promise<void>): Promise<void> {
    try {
        await task();
    } catch (error) {
        const message = formatError(error);
        outputChannel.appendLine(`Failed to ${description}: ${message}`);
        outputChannel.appendLine("");
        outputChannel.appendLine("Set phpantom.serverPath to a local phpantom_lsp binary, install phpantom_lsp on PATH, or enable phpantom.autoDownload.");
        vscode.window.showErrorMessage(`PHPantom failed to ${description}: ${message}`);
    }
}

function runLifecycleCommand(description: string, task: () => Promise<void>): Promise<void> {
    const run = lifecycleQueue.then(
        () => runCommand(description, task),
        () => runCommand(description, task)
    );
    lifecycleQueue = run.catch(() => undefined);
    return run;
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
