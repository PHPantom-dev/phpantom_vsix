import * as fs from "fs";
import * as vscode from "vscode";
import {
    ArtisanContext,
    findArtisanContexts,
    pickArtisanContext,
    runArtisanCapture
} from "./artisan";

// ── V4: Route list panel ─────────────────────────────────────────────────────
//
// A webview panel listing the application's routes (method, URI, name, action)
// sourced from `artisan route:list --json`, with a filter box and click-through
// from a route's action to the controller method that handles it. The data is
// re-sourced when the workspace's route files change, and a manual refresh entry
// re-runs the command on demand.
//
// This runs the user's application (booting it to enumerate routes), which is
// sanctioned editor tooling per the extension/server boundary: nothing it learns
// is fed back into the language server's type engine. It resolves controller
// files itself by matching the class's namespace against workspace files, so
// navigation works without asking the server anything.

/** A single route parsed from `route:list --json`. */
interface RouteEntry {
    /** HTTP verbs, e.g. `GET|HEAD`. */
    method: string;
    /** The route URI pattern, e.g. `api/users/{user}`. */
    uri: string;
    /** The route name, or an empty string when unnamed. */
    name: string;
    /** The action string: `Controller@method`, an invokable controller, or `Closure`. */
    action: string;
}

// Booting the app to enumerate routes is comparable to listing artisan commands,
// so the runner default is generous enough; keep it explicit for clarity.
const ROUTE_LIST_TIMEOUT_MS = 60_000;

// Coalesce bursts of route-file changes (a save can fire several events) into a
// single re-run, and avoid re-booting the app on every keystroke-triggered save.
const REFRESH_DEBOUNCE_MS = 600;

interface WebviewToExtension {
    type: "ready" | "refresh" | "open";
    action?: string;
}

/**
 * The route list panel. One instance is owned by the extension; it lazily picks
 * an Artisan context and opens the webview when the user runs the command.
 */
export class RouteList implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private panel: vscode.WebviewPanel | undefined;
    private watcher: vscode.FileSystemWatcher | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;

    /** The Laravel application the panel is currently showing routes for. */
    private context: ArtisanContext | undefined;
    /** The most recently loaded routes, resent whenever the webview reloads. */
    private routes: RouteEntry[] = [];

    constructor(
        private readonly extensionContext: vscode.ExtensionContext,
        private readonly outputChannel: vscode.OutputChannel
    ) {
        this.disposables.push(
            vscode.commands.registerCommand("phpantom.showRouteList", () => {
                void this.reveal();
            })
        );
    }

    dispose(): void {
        this.clearRefreshTimer();
        this.panel?.dispose();
        this.watcher?.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    // ── Panel lifecycle ──────────────────────────────────────────────────────

    /** Pick the Laravel app (once), open or focus the panel, and load routes. */
    private async reveal(): Promise<void> {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

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
        this.context = context;

        this.panel = vscode.window.createWebviewPanel(
            "phpantom.routeList",
            (vscode.workspace.workspaceFolders?.length ?? 0) > 1
                ? `Routes: ${context.folder.name}`
                : "PHPantom Routes",
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.webview.html = this.renderHtml(this.panel.webview);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.watcher?.dispose();
            this.watcher = undefined;
            this.clearRefreshTimer();
        });
        this.panel.webview.onDidReceiveMessage((message: WebviewToExtension) => {
            void this.handleMessage(message);
        });

        this.startWatching(context);
    }

    private async handleMessage(message: WebviewToExtension): Promise<void> {
        switch (message.type) {
            case "ready":
                await this.loadRoutes();
                return;
            case "refresh":
                await this.loadRoutes();
                return;
            case "open":
                if (message.action) {
                    await this.openAction(message.action);
                }
                return;
        }
    }

    // ── Route loading ────────────────────────────────────────────────────────

    /** Run `route:list --json`, parse it, and push the result to the webview. */
    private async loadRoutes(): Promise<void> {
        if (!this.context || !this.panel) {
            return;
        }
        const context = this.context;

        this.panel.webview.postMessage({ type: "loading" });

        const result = await runArtisanCapture(context, ["route:list", "--json"], {
            timeoutMs: ROUTE_LIST_TIMEOUT_MS
        });

        if (result.spawnError) {
            this.postError(
                `PHPantom could not run PHP (${context.php}). Set phpantom.phpPath to a PHP executable, or install PHP on your PATH.`
            );
            this.outputChannel.appendLine(`Route list failed to spawn: ${result.spawnError.message}`);
            return;
        }

        const routes = parseRoutes(result.stdout);
        if (!routes) {
            this.postError(
                "PHPantom could not read the route list. The application may have failed to boot. See the PHPantom output for details."
            );
            this.outputChannel.appendLine(
                `Unexpected route:list output (exit ${result.exitCode ?? "signal"}):\n${(result.stderr || result.stdout).slice(0, 4000)}`
            );
            return;
        }

        this.routes = routes;
        // A late load must not clobber a panel the user closed meanwhile.
        if (this.panel) {
            this.panel.webview.postMessage({ type: "routes", routes });
        }
    }

    private postError(message: string): void {
        vscode.window.showWarningMessage(message);
        this.panel?.webview.postMessage({ type: "error", message });
    }

    // ── Live refresh on route-file changes ───────────────────────────────────

    /**
     * Re-run `route:list` when the app's route files change. Watching the
     * `routes/` directory (rather than every controller) keeps re-boots to the
     * edits that can actually add, remove, or rename a route.
     */
    private startWatching(context: ArtisanContext): void {
        const pattern = new vscode.RelativePattern(context.folder, "routes/**/*.php");
        this.watcher = vscode.workspace.createFileSystemWatcher(pattern);
        const onChange = () => this.scheduleRefresh();
        this.watcher.onDidChange(onChange);
        this.watcher.onDidCreate(onChange);
        this.watcher.onDidDelete(onChange);
    }

    private scheduleRefresh(): void {
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.loadRoutes();
        }, REFRESH_DEBOUNCE_MS);
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    // ── Action click-through ─────────────────────────────────────────────────

    /**
     * Open the controller method that handles a route's action. Closures cannot
     * be located from `route:list` output (it only reports `Closure`), so those
     * report a message rather than guessing which route file to open.
     */
    private async openAction(action: string): Promise<void> {
        const target = parseAction(action);
        if (!target) {
            vscode.window.showInformationMessage(
                "This route is handled by a closure, so there is no controller to open."
            );
            return;
        }

        const location = await this.resolveActionLocation(target.className, target.method);
        if (!location) {
            vscode.window.showWarningMessage(`PHPantom could not locate ${target.className}.`);
            return;
        }

        const document = await vscode.workspace.openTextDocument(location.uri);
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: true
        });
        const position = new vscode.Position(location.line, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
    }

    /**
     * Find the file declaring `className` and the line of its `method`. The class
     * is located by matching its namespace and short name against workspace files
     * sharing the short name, so a `Foo` in the wrong namespace is not opened.
     */
    private async resolveActionLocation(
        className: string,
        method: string
    ): Promise<{ uri: vscode.Uri; line: number } | undefined> {
        const parts = className.split("\\").filter(Boolean);
        const shortName = parts[parts.length - 1];
        const namespace = parts.slice(0, -1).join("\\");
        if (!shortName) {
            return undefined;
        }

        const scope = this.context
            ? new vscode.RelativePattern(this.context.folder, `**/${shortName}.php`)
            : `**/${shortName}.php`;
        const candidates = await vscode.workspace.findFiles(scope, "**/{vendor,node_modules}/**", 50);

        for (const candidate of candidates) {
            let source: string;
            try {
                source = await fs.promises.readFile(candidate.fsPath, "utf8");
            } catch {
                continue;
            }
            if (!declaresClass(source, shortName, namespace)) {
                continue;
            }
            return { uri: candidate, line: findMethodLine(source, method) };
        }
        return undefined;
    }

    // ── Webview markup ───────────────────────────────────────────────────────

    private renderHtml(webview: vscode.Webview): string {
        const nonce = makeNonce();
        const csp = [
            "default-src 'none'",
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`
        ].join("; ");

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style>${STYLE}</style>
</head>
<body>
<header>
    <input id="search" type="search" placeholder="Filter by method, URI, name, or action…" />
    <button id="refresh" title="Reload routes">Refresh</button>
    <span id="count"></span>
</header>
<main id="routes"><div class="empty">Loading routes…</div></main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
    }
}

// ── Module-level parsing helpers ─────────────────────────────────────────────

/** Parse `route:list --json` output into our route model, or `undefined` on failure. */
function parseRoutes(stdout: string): RouteEntry[] | undefined {
    // PsySH-free `artisan route:list --json` prints a bare JSON array, but a
    // deprecation notice or warning can precede it; start at the first `[`.
    const start = stdout.indexOf("[");
    if (start === -1) {
        return undefined;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout.slice(start));
    } catch {
        return undefined;
    }
    if (!Array.isArray(parsed)) {
        return undefined;
    }

    const routes: RouteEntry[] = [];
    for (const raw of parsed) {
        if (typeof raw !== "object" || raw === null) {
            continue;
        }
        const record = raw as Record<string, unknown>;
        const uri = typeof record.uri === "string" ? record.uri : undefined;
        if (uri === undefined) {
            continue;
        }
        routes.push({
            method: typeof record.method === "string" ? record.method : "",
            uri,
            name: typeof record.name === "string" ? record.name : "",
            action: typeof record.action === "string" ? record.action : ""
        });
    }
    return routes;
}

/** A route's controller class and method, or `undefined` for closures. */
interface ActionTarget {
    className: string;
    method: string;
}

/**
 * Split a route action into a controller class and method. `Controller@method`
 * splits directly; a bare class name is an invokable controller (`__invoke`);
 * `Closure` (and anything without a namespace shape) has no controller to open.
 */
function parseAction(action: string): ActionTarget | undefined {
    const trimmed = action.trim();
    if (trimmed === "" || trimmed === "Closure") {
        return undefined;
    }

    const at = trimmed.indexOf("@");
    if (at !== -1) {
        return { className: trimmed.slice(0, at), method: trimmed.slice(at + 1) };
    }

    // An invokable controller is reported as its class name alone. Require a
    // class-like shape (a namespace separator or a leading uppercase segment) so
    // a stray middleware label is not mistaken for a class.
    if (trimmed.includes("\\") || /^[A-Z]/.test(trimmed)) {
        return { className: trimmed, method: "__invoke" };
    }
    return undefined;
}

/** Whether `source` declares `shortName` in `namespace` (empty for the global namespace). */
function declaresClass(source: string, shortName: string, namespace: string): boolean {
    const classPattern = new RegExp(`\\bclass\\s+${escapeRegExp(shortName)}\\b`);
    if (!classPattern.test(source)) {
        return false;
    }
    if (namespace === "") {
        return !/^\s*namespace\s+/m.test(source);
    }
    const namespacePattern = new RegExp(`^\\s*namespace\\s+${escapeRegExp(namespace)}\\s*;`, "m");
    return namespacePattern.test(source);
}

/** Zero-based line of `method`'s declaration in `source`, or the class line as a fallback. */
function findMethodLine(source: string, method: string): number {
    const lines = source.split(/\r?\n/);
    const methodPattern = new RegExp(`function\\s+${escapeRegExp(method)}\\s*\\(`);
    for (let line = 0; line < lines.length; line++) {
        if (methodPattern.test(lines[line])) {
            return line;
        }
    }
    // The method could not be found (e.g. it is inherited from a base
    // controller); fall back to the class declaration so the file still opens
    // somewhere useful.
    const classPattern = /\bclass\s+/;
    for (let line = 0; line < lines.length; line++) {
        if (classPattern.test(lines[line])) {
            return line;
        }
    }
    return 0;
}

/** Escape a string for safe embedding in a `RegExp`. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeNonce(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let nonce = "";
    for (let i = 0; i < 32; i++) {
        nonce += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return nonce;
}

// ── Webview assets (inlined so the panel needs no bundled resources) ──────────

const STYLE = `
:root { color-scheme: light dark; }
body {
    margin: 0;
    padding: 0;
    font-family: var(--vscode-font-family);
    font-size: 13px;
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    height: 100vh;
    display: flex;
    flex-direction: column;
}
header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.35));
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    flex: 0 0 auto;
    font-size: 12px;
}
header input[type="search"] {
    flex: 1 1 auto;
    min-width: 120px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
}
header button {
    background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
    border: none;
    padding: 3px 10px;
    border-radius: 3px;
    cursor: pointer;
    font-size: 12px;
}
header button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground)); }
#count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
main {
    flex: 1 1 auto;
    overflow: auto;
}
table { border-collapse: collapse; width: 100%; font-family: var(--vscode-editor-font-family, monospace); }
th, td {
    text-align: left;
    padding: 3px 10px;
    vertical-align: top;
    border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
}
th {
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    font-family: var(--vscode-font-family);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--vscode-descriptionForeground);
}
tbody tr:hover { background: var(--vscode-list-hoverBackground); }
td.method { white-space: nowrap; }
.verb {
    display: inline-block;
    font-weight: 600;
    font-size: 11px;
    padding: 0 4px;
    margin-right: 2px;
    border-radius: 3px;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
}
.verb.get { color: var(--vscode-charts-green, #388a34); }
.verb.post { color: var(--vscode-charts-blue, #3794ff); }
.verb.put, .verb.patch { color: var(--vscode-charts-orange, #cca700); }
.verb.delete { color: var(--vscode-charts-red, #f14c4c); }
td.uri { word-break: break-all; }
td.name { color: var(--vscode-descriptionForeground); }
td.action a {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
    word-break: break-all;
}
td.action a:hover { text-decoration: underline; }
td.action span.closure { color: var(--vscode-descriptionForeground); font-style: italic; }
.empty { padding: 12px; color: var(--vscode-descriptionForeground); }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const routesEl = document.getElementById("routes");
const searchEl = document.getElementById("search");
const refreshEl = document.getElementById("refresh");
const countEl = document.getElementById("count");

let routes = [];

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function renderMethod(method) {
    if (!method) { return ""; }
    return method.split("|").map((verb) => {
        const cls = verb.trim().toLowerCase();
        return '<span class="verb ' + escapeHtml(cls) + '">' + escapeHtml(verb) + "</span>";
    }).join("");
}

function renderAction(action) {
    const trimmed = (action || "").trim();
    if (trimmed === "" || trimmed === "Closure") {
        return '<span class="closure">' + escapeHtml(trimmed || "Closure") + "</span>";
    }
    return '<a data-action="' + escapeHtml(trimmed) + '">' + escapeHtml(trimmed) + "</a>";
}

function render() {
    const needle = searchEl.value.trim().toLowerCase();
    const parts = [];
    let shown = 0;

    for (const r of routes) {
        if (needle) {
            const hay = (r.method + " " + r.uri + " " + r.name + " " + r.action).toLowerCase();
            if (hay.indexOf(needle) === -1) { continue; }
        }
        shown++;
        parts.push(
            "<tr>" +
            '<td class="method">' + renderMethod(r.method) + "</td>" +
            '<td class="uri">' + escapeHtml(r.uri) + "</td>" +
            '<td class="name">' + escapeHtml(r.name) + "</td>" +
            '<td class="action">' + renderAction(r.action) + "</td>" +
            "</tr>"
        );
    }

    if (shown === 0) {
        routesEl.innerHTML = '<div class="empty">' +
            (routes.length === 0 ? "No routes found." : "No matching routes.") + "</div>";
    } else {
        routesEl.innerHTML =
            "<table><thead><tr><th>Method</th><th>URI</th><th>Name</th><th>Action</th></tr></thead>" +
            "<tbody>" + parts.join("") + "</tbody></table>";
    }
    countEl.textContent = shown + (shown === 1 ? " route" : " routes");
}

routesEl.addEventListener("click", (event) => {
    const target = event.target.closest("a[data-action]");
    if (target) {
        event.preventDefault();
        vscode.postMessage({ type: "open", action: target.getAttribute("data-action") });
    }
});

searchEl.addEventListener("input", render);
refreshEl.addEventListener("click", () => {
    routesEl.innerHTML = '<div class="empty">Loading routes…</div>';
    countEl.textContent = "";
    vscode.postMessage({ type: "refresh" });
});

window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "routes") {
        routes = msg.routes;
        render();
    } else if (msg.type === "loading") {
        routesEl.innerHTML = '<div class="empty">Loading routes…</div>';
        countEl.textContent = "";
    } else if (msg.type === "error") {
        routes = [];
        routesEl.innerHTML = '<div class="empty">' + escapeHtml(msg.message) + "</div>";
        countEl.textContent = "";
    }
});

vscode.postMessage({ type: "ready" });
`;
