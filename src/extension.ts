import { ChildProcessWithoutNullStreams, execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/node";
import { applyConfiguredTrace, startClient } from "./client";
import {
    checkForServerUpdate,
    clearDownloadedServer
} from "./downloader";
import { registerHoverCommands } from "./hover";

let client: LanguageClient | undefined;
let activeServerPath: string | undefined;
let activeServerProcess: ChildProcessWithoutNullStreams | undefined;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let updateTimer: NodeJS.Timeout | undefined;
let updateCheckInProgress = false;
let lifecycleQueue: Promise<void> = Promise.resolve();
let pendingUpdateServerPath: string | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    void promptDeprecatedMigration();

    outputChannel = vscode.window.createOutputChannel("PHPantom");
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "phpantom.showOutput";
    context.subscriptions.push(statusBarItem);
    registerHoverCommands(context);
    setStatus("starting", "PHPantom language server is starting.");

    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.restartServer", async () => {
            await restartServer(context);
        }),
        vscode.commands.registerCommand("phpantom.showOutput", () => {
            outputChannel.show();
        }),
        vscode.commands.registerCommand("phpantom.showServerVersion", async () => {
            await showServerVersion(context);
        }),
        vscode.commands.registerCommand("phpantom.checkForUpdate", async () => {
            await checkForUpdates(context, true);
        }),
        vscode.commands.registerCommand("phpantom.downloadServer", async () => {
            await checkForUpdates(context, true);
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

            const changedServerSettings = getChangedServerSettings(event);
            const serverResolutionChanged = changedServerSettings.length > 0;

            if (
                event.affectsConfiguration("phpantom.autoUpdate")
                || event.affectsConfiguration("phpantom.updateCheckIntervalHours")
                || serverResolutionChanged
            ) {
                scheduleServerUpdateChecks(context);
            }

            if (serverResolutionChanged) {
                const message = `PHPantom language server restarting because ${changedServerSettings.join(", ")} changed.`;
                outputChannel.appendLine(message);
                vscode.window.showInformationMessage(message);
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

const OFFICIAL_EXTENSION_ID = "phpantom.phpantom";
const DEPRECATED_EXTENSION_ID = "CicerBro.phpantom";

async function promptDeprecatedMigration(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
        "This PHPantom extension (CicerBro.phpantom) is deprecated. Install the official phpantom.phpantom extension, then uninstall this one.",
        "Install Official"
    );

    if (choice !== "Install Official") {
        return;
    }

    try {
        await vscode.commands.executeCommand(
            "workbench.extensions.installExtension",
            OFFICIAL_EXTENSION_ID
        );
        await vscode.commands.executeCommand(
            "workbench.extensions.uninstallExtension",
            DEPRECATED_EXTENSION_ID
        );
    } catch (error) {
        vscode.window.showErrorMessage(
            `Failed to migrate to ${OFFICIAL_EXTENSION_ID}: ${formatError(error)}`
        );
    }
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
        setReadyStatus(context);
        return;
    }

    setStatus("starting", "PHPantom language server is starting.");
    const started = await startClient(context, outputChannel);
    client = started.client;
    activeServerPath = started.serverPath;
    activeServerProcess = started.serverProcess;
    if (pendingUpdateServerPath === activeServerPath) {
        pendingUpdateServerPath = undefined;
    }
    setReadyStatus(context);
    logStartupSummary(context);
}

async function stopClient(): Promise<void> {
    if (!client) {
        return;
    }

    setStatus("stopping", "PHPantom language server is stopping.");
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
    setStatus("stopped", "PHPantom language server is stopped.");
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
        await handleUpdateResult(context, result, false);
    } catch (error) {
        outputChannel.appendLine(
            `Background PHPantom update check failed during ${reason}: ${formatError(error)}`
        );
        setReadyStatus(context);
    } finally {
        updateCheckInProgress = false;
    }
}

async function checkForUpdates(context: vscode.ExtensionContext, manual: boolean): Promise<void> {
    await runCommand("check for PHPantom language server update", async () => {
        setStatus("updating", "Checking for PHPantom language server updates.");
        const result = await checkForServerUpdate(context, outputChannel, { manual });
        await handleUpdateResult(context, result, manual);
    });
    setReadyStatus(context);
}

async function handleUpdateResult(
    context: vscode.ExtensionContext,
    result: Awaited<ReturnType<typeof checkForServerUpdate>>,
    manual: boolean
): Promise<void> {
    if (result.status === "skipped") {
        const message = `Skipping PHPantom update check: ${result.reason}.`;
        outputChannel.appendLine(message);
        if (manual) {
            vscode.window.showInformationMessage(message);
        }
        setReadyStatus(context);
        return;
    }

    if (!result.serverPath) {
        setReadyStatus(context);
        return;
    }

    if (activeServerPath === result.serverPath) {
        if (manual) {
            vscode.window.showInformationMessage(`PHPantom language server is current (${result.releaseTag}).`);
        }
        setReadyStatus(context);
        return;
    }

    const action = result.status === "updated"
        ? `Downloaded PHPantom language server ${result.releaseTag}.`
        : `Found cached PHPantom language server ${result.releaseTag}.`;

    outputChannel.appendLine(`${action} Restart is required to use ${result.serverPath}.`);
    pendingUpdateServerPath = result.serverPath;
    setStatus("updateReady", `PHPantom ${result.releaseTag} is ready. Restart to use ${result.serverPath}.`);

    const choice = await vscode.window.showInformationMessage(
        `${action} Restart PHPantom now?`,
        "Restart Now",
        "Later"
    );

    if (choice === "Restart Now") {
        await restartServer(context);
        return;
    }

    outputChannel.appendLine("PHPantom language server update will be used after the next restart.");
}

async function showServerVersion(context: vscode.ExtensionContext): Promise<void> {
    await runCommand("show PHPantom language server version", async () => {
        if (!activeServerPath) {
            throw new Error("PHPantom language server is not running.");
        }

        const version = await getServerVersion(activeServerPath);
        const source = describeServerSource(context, activeServerPath);
        const details = [
            "",
            "PHPantom language server",
            `Version: ${version}`,
            `Source: ${source}`,
            `Path: ${activeServerPath}`
        ].join("\n");

        outputChannel.appendLine(details);

        const choice = await vscode.window.showInformationMessage(
            `PHPantom language server ${version} (${source})`,
            "Show Output"
        );

        if (choice === "Show Output") {
            outputChannel.show();
        }
    });
}

function getServerVersion(binaryPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(binaryPath, ["--version"], { timeout: 3000 }, (error, stdout, stderr) => {
            if (error) {
                reject(error);
                return;
            }

            const version = `${stdout}${stderr}`.trim().split(/\r?\n/)[0]?.trim();
            resolve(version || "unknown");
        });
    });
}

function logStartupSummary(context: vscode.ExtensionContext): void {
    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(no workspace)";
    const source = describeServerSource(context, activeServerPath);

    outputChannel.appendLine("");
    outputChannel.appendLine("PHPantom startup");
    outputChannel.appendLine(`Extension version: ${getExtensionVersion(context)}`);
    outputChannel.appendLine(`Workspace: ${workspace}`);
    outputChannel.appendLine(`Server source: ${source}`);
    outputChannel.appendLine(`Server path: ${activeServerPath ?? "(not running)"}`);
    outputChannel.appendLine(`Auto update: ${getAutoUpdateSummary(source)}`);
    outputChannel.appendLine("");
}

function getExtensionVersion(context: vscode.ExtensionContext): string {
    const packageJson = context.extension.packageJSON as { version?: unknown };
    return typeof packageJson.version === "string" ? packageJson.version : "unknown";
}

function getChangedServerSettings(event: vscode.ConfigurationChangeEvent): string[] {
    return [
        "phpantom.serverPath",
        "phpantom.releaseTag",
        "phpantom.autoDownload"
    ].filter((setting) => event.affectsConfiguration(setting));
}

function describeServerSource(
    context: vscode.ExtensionContext,
    serverPath: string | undefined
): string {
    if (!serverPath) {
        return "not running";
    }

    const configuredServerPath = vscode.workspace
        .getConfiguration("phpantom")
        .get<string>("serverPath", "")
        .trim();

    if (configuredServerPath && samePath(expandHome(configuredServerPath), serverPath)) {
        return "phpantom.serverPath";
    }

    if (isInsidePath(serverPath, context.globalStorageUri.fsPath)) {
        return "downloaded cache";
    }

    return "PATH or external";
}

function getAutoUpdateSummary(serverSource: string): string {
    const config = vscode.workspace.getConfiguration("phpantom");

    if (!config.get<boolean>("autoUpdate", true)) {
        return "skipped (phpantom.autoUpdate is disabled)";
    }

    if (!config.get<boolean>("autoDownload", true)) {
        return "skipped (phpantom.autoDownload is disabled)";
    }

    if (serverSource === "phpantom.serverPath") {
        return "skipped (phpantom.serverPath is configured)";
    }

    if (serverSource === "PATH or external") {
        return "skipped (PATH or external binary has priority)";
    }

    const releaseTag = config.get<string>("releaseTag", "latest").trim() || "latest";
    if (releaseTag !== "latest") {
        return `skipped (phpantom.releaseTag is pinned to ${releaseTag})`;
    }

    return `enabled (every ${getUpdateCheckIntervalHours()} hours)`;
}

function setReadyStatus(context: vscode.ExtensionContext): void {
    if (!activeServerPath) {
        setStatus("stopped", "PHPantom language server is stopped.");
        return;
    }

    if (pendingUpdateServerPath && pendingUpdateServerPath !== activeServerPath) {
        setStatus("updateReady", `PHPantom update is ready. Restart to use ${pendingUpdateServerPath}.`);
        return;
    }

    setStatus(
        "ready",
        `PHPantom language server is running.\nSource: ${describeServerSource(context, activeServerPath)}\nPath: ${activeServerPath}`
    );
}

type StatusKind = "starting" | "ready" | "stopping" | "stopped" | "updating" | "updateReady" | "failed";

function setStatus(kind: StatusKind, tooltip: string): void {
    if (!statusBarItem) {
        return;
    }

    statusBarItem.tooltip = tooltip;
    statusBarItem.backgroundColor = undefined;

    switch (kind) {
        case "starting":
            statusBarItem.text = "$(sync~spin) PHPantom";
            break;
        case "ready":
            statusBarItem.text = "$(check) PHPantom";
            break;
        case "stopping":
            statusBarItem.text = "$(debug-stop) PHPantom";
            break;
        case "stopped":
            statusBarItem.text = "$(circle-slash) PHPantom";
            break;
        case "updating":
            statusBarItem.text = "$(cloud-download) PHPantom";
            break;
        case "updateReady":
            statusBarItem.text = "$(arrow-up) PHPantom";
            statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
            break;
        case "failed":
            statusBarItem.text = "$(error) PHPantom";
            statusBarItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
            break;
    }

    statusBarItem.show();
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
        if (description.includes("start") || description.includes("restart")) {
            setStatus("failed", `PHPantom failed to ${description}: ${message}`);
        }
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

function samePath(left: string, right: string): boolean {
    return path.resolve(left) === path.resolve(right);
}

function isInsidePath(child: string, parent: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function expandHome(file: string): string {
    if (file === "~") {
        return process.env.HOME ?? file;
    }

    if (file.startsWith(`~${path.sep}`)) {
        const home = process.env.HOME;
        return home ? path.join(home, file.slice(2)) : file;
    }

    return file;
}

function formatError(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }

    return String(error);
}
