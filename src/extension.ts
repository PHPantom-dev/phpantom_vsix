import { execFile } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { registerArtisanCommands } from "./artisanCommand";
import { applyConfiguredTrace, startClient, StartedClient } from "./client";
import {
    checkForServerUpdate,
    clearDownloadedServer,
    resolveServerBinary
} from "./downloader";
import { registerLaravelMakeCommands } from "./laravelMake";
import { LogViewer } from "./logViewer";
import { registerModelAnnotationCommands } from "./modelAnnotations";
import { RouteList } from "./routeList";

// One language server is launched per (outermost) workspace folder, keyed by
// the folder URI. A folderless client handles untitled buffers. This mirrors
// the Zed extension, which runs one server per worktree, and keeps multi-root
// workspaces correct: each project is indexed by its own server.
const clients = new Map<string, StartedClient>();
let defaultClient: StartedClient | undefined;

// The phpantom_lsp binary is shared by every per-folder server. It is resolved
// (and downloaded if needed) once; subsequent folders reuse the same path.
let serverPathPromise: Promise<string> | undefined;
let resolvedServerPath: string | undefined;

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let updateTimer: NodeJS.Timeout | undefined;
let updateCheckInProgress = false;
let lifecycleQueue: Promise<void> = Promise.resolve();
let pendingUpdateServerPath: string | undefined;

let _sortedWorkspaceFolders: string[] | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    outputChannel = vscode.window.createOutputChannel("PHPantom");
    context.subscriptions.push(outputChannel);

    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.command = "phpantom.showOutput";
    context.subscriptions.push(statusBarItem);
    setStatus("starting", "PHPantom language server is starting.");

    registerPhpLanguageConfiguration(context);

    context.subscriptions.push(new LogViewer(context));

    registerArtisanCommands(context, outputChannel);

    registerLaravelMakeCommands(context, outputChannel);

    registerModelAnnotationCommands(context, outputChannel);

    context.subscriptions.push(new RouteList(context, outputChannel));

    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.restartServer", async () => {
            await restartServers(context);
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
                await stopAllClients();
                resetServerPathCache();
                await clearDownloadedServer(context);
                vscode.window.showInformationMessage("Downloaded PHPantom language servers were cleared.");
            });
        }),
        vscode.workspace.onDidChangeConfiguration((event) => {
            if (event.affectsConfiguration("phpantom.trace.server")) {
                for (const started of allStartedClients()) {
                    applyConfiguredTrace(started.client);
                }
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
                void restartServers(context);
            }
        })
    );
    context.subscriptions.push(new vscode.Disposable(clearUpdateTimer));

    // Start a server for every folder that already has an open PHP document,
    // and for any opened later. Folders without an open PHP file stay dormant
    // until one is opened, matching VS Code's lazy multi-root activation.
    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument((document) => {
            void runLifecycleCommand("start PHPantom language server", () =>
                ensureClientForDocument(context, document)
            );
        }),
        vscode.workspace.onDidChangeWorkspaceFolders((event) => {
            _sortedWorkspaceFolders = undefined;
            void runLifecycleCommand("update PHPantom language servers", async () => {
                for (const folder of event.removed) {
                    await stopFolderClient(folder);
                }
                // The folderless client's document selector is fixed at
                // creation. If folder presence changed it may now match the
                // wrong set (e.g. a broad client that would clash with new
                // per-folder clients), so rebuild it from scratch.
                if (defaultClient) {
                    const stale = defaultClient;
                    defaultClient = undefined;
                    await stopStartedClient(stale);
                }
                // Folders added to the workspace may already own open documents.
                await startClientsForOpenDocuments(context);
            });
        })
    );

    await runLifecycleCommand("start PHPantom language server", () =>
        startClientsForOpenDocuments(context)
    );

    scheduleServerUpdateChecks(context);
}

export async function deactivate(): Promise<void> {
    clearUpdateTimer();
    await lifecycleQueue;
    await stopAllClients();
}

// PHP editor behaviour that is purely client-side (no language server
// involvement): continue docblock/`*` comment lines on Enter and outdent after
// a single-line control-flow statement. VS Code's built-in PHP grammar covers
// the basics; these rules match what users expect from a dedicated PHP
// extension.
function registerPhpLanguageConfiguration(context: vscode.ExtensionContext): void {
    const disposable = vscode.languages.setLanguageConfiguration("php", {
        onEnterRules: [
            {
                // e.g. /** | */
                beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
                afterText: /^\s*\*\/$/,
                action: { indentAction: vscode.IndentAction.IndentOutdent, appendText: " * " }
            },
            {
                // e.g. /** ...|
                beforeText: /^\s*\/\*\*(?!\/)([^*]|\*(?!\/))*$/,
                action: { indentAction: vscode.IndentAction.None, appendText: " * " }
            },
            {
                // e.g.  * ...|
                beforeText: /^(\t|( ))* \*( ([^*]|\*(?!\/))*)?$/,
                action: { indentAction: vscode.IndentAction.None, appendText: "* " }
            },
            {
                // e.g.  */|
                beforeText: /^(\t|( ))* \*\/\s*$/,
                action: { indentAction: vscode.IndentAction.None, removeText: 1 }
            },
            {
                // e.g.  *-----*/|
                beforeText: /^(\t|( ))* \*[^/]*\*\/\s*$/,
                action: { indentAction: vscode.IndentAction.None, removeText: 1 }
            },
            {
                // Decrease indentation after a single-line if/else if/else,
                // for, foreach, or while that has no braces.
                previousLineText: /^\s*(((else ?)?if|for(each)?|while)\s*\(.*\)\s*|else\s*)$/,
                beforeText: /^\s+([^{i\s]|i(?!f\b))/,
                action: { indentAction: vscode.IndentAction.Outdent }
            }
        ]
    });
    context.subscriptions.push(disposable);
}

function allStartedClients(): StartedClient[] {
    const all = [...clients.values()];
    if (defaultClient) {
        all.push(defaultClient);
    }
    return all;
}

function hasRunningClient(): boolean {
    return clients.size > 0 || defaultClient !== undefined;
}

// ── Workspace folder helpers ────────────────────────────────────────────────
//
// Nested workspace folders share a single server rooted at the outermost
// folder, so a file in a sub-folder is not indexed twice.

function sortedWorkspaceFolders(): string[] {
    if (_sortedWorkspaceFolders === undefined) {
        _sortedWorkspaceFolders = (vscode.workspace.workspaceFolders ?? [])
            .map((folder) => {
                let result = folder.uri.toString();
                if (!result.endsWith("/")) {
                    result = result + "/";
                }
                return result;
            })
            .sort((a, b) => a.length - b.length);
    }
    return _sortedWorkspaceFolders;
}

function getOuterMostWorkspaceFolder(folder: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
    for (const element of sortedWorkspaceFolders()) {
        let uri = folder.uri.toString();
        if (!uri.endsWith("/")) {
            uri = uri + "/";
        }
        if (uri.startsWith(element)) {
            return vscode.workspace.getWorkspaceFolder(vscode.Uri.parse(element)) ?? folder;
        }
    }
    return folder;
}

// ── Server binary resolution (shared across folders) ─────────────────────────

function resolveSharedServerPath(context: vscode.ExtensionContext): Promise<string> {
    if (!serverPathPromise) {
        serverPathPromise = resolveServerBinary(context, outputChannel)
            .then((serverPath) => {
                resolvedServerPath = serverPath;
                return serverPath;
            })
            .catch((error) => {
                // Allow a later folder (or retry) to attempt resolution again.
                serverPathPromise = undefined;
                throw error;
            });
    }
    return serverPathPromise;
}

function resetServerPathCache(): void {
    serverPathPromise = undefined;
    resolvedServerPath = undefined;
}

// ── Client lifecycle (internal, not queued) ──────────────────────────────────

async function startClientsForOpenDocuments(context: vscode.ExtensionContext): Promise<void> {
    for (const document of vscode.workspace.textDocuments) {
        await ensureClientForDocument(context, document);
    }
    setReadyStatus(context);
}

async function ensureClientForDocument(
    context: vscode.ExtensionContext,
    document: vscode.TextDocument
): Promise<void> {
    if (document.languageId !== "php" && document.languageId !== "blade") {
        return;
    }

    const uri = document.uri;

    if (uri.scheme === "untitled") {
        if (!defaultClient) {
            await startFolderClient(context, undefined);
        }
        return;
    }

    if (uri.scheme !== "file") {
        return;
    }

    const owningFolder = vscode.workspace.getWorkspaceFolder(uri);
    if (!owningFolder) {
        // A file outside every workspace folder. When no folder is open at all
        // (the user opened a single file), the folderless client handles it so
        // basic language features keep working. When folders exist, the server
        // is root-oriented and there is no project to index it against, so it
        // is left unhandled rather than indexed against the wrong project.
        if (!hasWorkspaceFolders() && !defaultClient) {
            await startFolderClient(context, undefined);
        }
        return;
    }

    const folder = getOuterMostWorkspaceFolder(owningFolder);
    if (clients.has(folder.uri.toString())) {
        return;
    }

    await startFolderClient(context, folder);
}

function hasWorkspaceFolders(): boolean {
    return (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
}

async function startFolderClient(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder | undefined
): Promise<void> {
    const label = folder ? folder.name : "untitled files";
    setStatus("starting", `PHPantom language server is starting for ${label}.`);

    const serverPath = await resolveSharedServerPath(context);
    // Only the folderless client, and only when no workspace folder is open,
    // may claim on-disk files; otherwise it would double up with per-folder
    // clients and produce duplicate results.
    const matchOnDiskFiles = !folder && !hasWorkspaceFolders();
    const started = await startClient(serverPath, folder, outputChannel, matchOnDiskFiles);

    if (folder) {
        clients.set(folder.uri.toString(), started);
    } else {
        defaultClient = started;
    }

    if (pendingUpdateServerPath === serverPath) {
        pendingUpdateServerPath = undefined;
    }

    setReadyStatus(context);
    logStartupSummary(context, folder);
}

async function stopAllClients(): Promise<void> {
    if (!hasRunningClient()) {
        return;
    }

    setStatus("stopping", "PHPantom language server is stopping.");

    const all = allStartedClients();
    clients.clear();
    defaultClient = undefined;

    for (const started of all) {
        await stopStartedClient(started);
    }

    outputChannel.appendLine("PHPantom language servers stopped.");
    setStatus("stopped", "PHPantom language server is stopped.");
}

async function stopFolderClient(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = folder.uri.toString();
    const started = clients.get(key);
    if (!started) {
        return;
    }

    clients.delete(key);
    await stopStartedClient(started);
    outputChannel.appendLine(`PHPantom language server for ${folder.name} stopped.`);
}

async function stopStartedClient(started: StartedClient): Promise<void> {
    try {
        await started.client.stop(1000);
    } catch (error) {
        outputChannel.appendLine(`Graceful PHPantom language server stop timed out or failed: ${formatError(error)}`);
    }

    await terminateServerProcess(started);
}

// ── Queued lifecycle commands ────────────────────────────────────────────────

async function restartServers(context: vscode.ExtensionContext): Promise<void> {
    await runLifecycleCommand("restart PHPantom language server", async () => {
        outputChannel.appendLine("Restarting PHPantom language servers.");
        await stopAllClients();
        // Re-resolve the binary so a pending update is picked up on restart.
        resetServerPathCache();
        await startClientsForOpenDocuments(context);
    });
}

async function terminateServerProcess(started: StartedClient): Promise<void> {
    const serverProcess = started.serverProcess;
    if (!isProcessRunning(started)) {
        return;
    }

    if (await waitForProcessExit(started, 1000)) {
        return;
    }

    outputChannel.appendLine("PHPantom language server did not exit after 1000ms; terminating process.");
    serverProcess.kill("SIGTERM");

    if (await waitForProcessExit(started, 500)) {
        return;
    }

    if (process.platform !== "win32") {
        outputChannel.appendLine("PHPantom language server ignored SIGTERM; forcing SIGKILL.");
        serverProcess.kill("SIGKILL");
        await waitForProcessExit(started, 500);
    }
}

function isProcessRunning(started: StartedClient): boolean {
    const serverProcess = started.serverProcess;
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

function waitForProcessExit(started: StartedClient, timeoutMs: number): Promise<boolean> {
    if (!isProcessRunning(started)) {
        return Promise.resolve(true);
    }

    const serverProcess = started.serverProcess;
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

    if (resolvedServerPath === result.serverPath) {
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
        await restartServers(context);
        return;
    }

    outputChannel.appendLine("PHPantom language server update will be used after the next restart.");
}

async function showServerVersion(context: vscode.ExtensionContext): Promise<void> {
    await runCommand("show PHPantom language server version", async () => {
        if (!resolvedServerPath) {
            throw new Error("PHPantom language server is not running.");
        }

        const version = await getServerVersion(resolvedServerPath);
        const source = describeServerSource(context, resolvedServerPath);
        const details = [
            "",
            "PHPantom language server",
            `Version: ${version}`,
            `Source: ${source}`,
            `Path: ${resolvedServerPath}`,
            `Running servers: ${describeRunningServers()}`
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

function describeRunningServers(): string {
    const names = [...clients.values()]
        .map((started) => started.folder?.name)
        .filter((name): name is string => Boolean(name));
    if (defaultClient) {
        names.push("untitled files");
    }
    return names.length > 0 ? names.join(", ") : "none";
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

function logStartupSummary(
    context: vscode.ExtensionContext,
    folder: vscode.WorkspaceFolder | undefined
): void {
    const workspace = folder?.uri.fsPath ?? "(untitled files)";
    const source = describeServerSource(context, resolvedServerPath);

    outputChannel.appendLine("");
    outputChannel.appendLine("PHPantom startup");
    outputChannel.appendLine(`Extension version: ${getExtensionVersion(context)}`);
    outputChannel.appendLine(`Workspace folder: ${workspace}`);
    outputChannel.appendLine(`Server source: ${source}`);
    outputChannel.appendLine(`Server path: ${resolvedServerPath ?? "(not running)"}`);
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
    if (!hasRunningClient()) {
        setStatus("stopped", "PHPantom language server is stopped.");
        return;
    }

    if (pendingUpdateServerPath && pendingUpdateServerPath !== resolvedServerPath) {
        setStatus("updateReady", `PHPantom update is ready. Restart to use ${pendingUpdateServerPath}.`);
        return;
    }

    setStatus(
        "ready",
        `PHPantom language server is running.\nSource: ${describeServerSource(context, resolvedServerPath)}\nPath: ${resolvedServerPath}\nServers: ${describeRunningServers()}`
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
