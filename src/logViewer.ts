import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// Laravel writes to `storage/logs/laravel.log` (single file) or
// `storage/logs/laravel-YYYY-MM-DD.log` (daily channel). Match any `.log`
// directly inside a `storage/logs` directory in the workspace. `vendor` and
// `node_modules` are excluded so package fixtures do not pollute the list.
const LOG_GLOB = "**/storage/logs/*.log";
const LOG_EXCLUDE = "**/{vendor,node_modules}/**";

// A tail viewer only ever shows the end of a file. Reading (and re-parsing) the
// last quarter-megabyte on every change is cheap because log writes are
// user-paced, and it sidesteps partial-line/dedup bookkeeping entirely: each
// refresh is a full, self-consistent snapshot of the file's tail.
const MAX_TAIL_BYTES = 256 * 1024;
// Bound the rendered DOM even when 256 KB is all on a handful of very long
// lines is not the concern; a runaway loop dumping thousands of short lines is.
const MAX_TAIL_LINES = 5000;

// Coalesce bursts of change events (a single log write can fire several) into
// one refresh so the webview is not re-rendered dozens of times per second.
const REFRESH_DEBOUNCE_MS = 150;

interface WebviewToExtension {
    type: "ready" | "selectFile" | "open";
    path?: string;
    line?: number;
}

/**
 * A quality-of-life panel that tails `storage/logs/*.log` with Laravel log
 * level highlighting and click-through on stack-trace frames. Plain file
 * tailing only, no log-shipping integrations.
 *
 * A status bar item exposes the panel and shows a subtle dot whenever a watched
 * log file changes while the panel is not being looked at, so a new error is
 * noticeable without stealing focus. The dot clears the moment the panel is
 * revealed.
 */
export class LogViewer implements vscode.Disposable {
    private readonly disposables: vscode.Disposable[] = [];
    private readonly statusBarItem: vscode.StatusBarItem;
    private watcher: vscode.FileSystemWatcher | undefined;
    private panel: vscode.WebviewPanel | undefined;
    private refreshTimer: NodeJS.Timeout | undefined;

    /** Absolute paths of every discovered log file, most-recently-modified first. */
    private files: string[] = [];
    /** The file currently shown in the panel. */
    private activeFile: string | undefined;
    /** Set when a log changed while the panel was hidden or closed. */
    private hasUnread = false;

    constructor(private readonly context: vscode.ExtensionContext) {
        this.statusBarItem = vscode.window.createStatusBarItem(
            vscode.StatusBarAlignment.Right,
            99
        );
        this.statusBarItem.command = "phpantom.showLogViewer";

        this.disposables.push(
            this.statusBarItem,
            vscode.commands.registerCommand("phpantom.showLogViewer", () => {
                void this.reveal();
            }),
            vscode.workspace.onDidChangeWorkspaceFolders(() => {
                void this.refreshFileList();
            })
        );

        this.startWatching();
        void this.refreshFileList();
    }

    dispose(): void {
        this.clearRefreshTimer();
        this.panel?.dispose();
        this.watcher?.dispose();
        for (const disposable of this.disposables) {
            disposable.dispose();
        }
    }

    // ── File discovery and watching ──────────────────────────────────────────

    private startWatching(): void {
        this.watcher = vscode.workspace.createFileSystemWatcher(LOG_GLOB);
        this.watcher.onDidChange((uri) => this.onFileChanged(uri));
        this.watcher.onDidCreate((uri) => this.onFileChanged(uri));
        this.watcher.onDidDelete(() => this.scheduleRefresh());
    }

    private onFileChanged(uri: vscode.Uri): void {
        if (isExcluded(uri.fsPath)) {
            return;
        }
        // A change while the panel is not visible is what the unread dot is for.
        if (!this.panelIsVisible()) {
            this.setUnread(true);
        }
        this.scheduleRefresh();
    }

    private scheduleRefresh(): void {
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            void this.refreshFileList();
        }, REFRESH_DEBOUNCE_MS);
    }

    private clearRefreshTimer(): void {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    /**
     * Re-scan the workspace for log files, ordered newest first, and push the
     * result (plus the active file's content) to the panel if it is open.
     */
    private async refreshFileList(): Promise<void> {
        const found = await vscode.workspace.findFiles(LOG_GLOB, LOG_EXCLUDE);
        const withMtime = await Promise.all(
            found
                .map((uri) => uri.fsPath)
                .filter((fsPath) => !isExcluded(fsPath))
                .map(async (fsPath) => ({ fsPath, mtime: await mtimeOf(fsPath) }))
        );
        this.files = withMtime
            .sort((a, b) => b.mtime - a.mtime)
            .map((entry) => entry.fsPath);

        // Only surface the status bar item once a project actually has logs.
        if (this.files.length > 0) {
            this.updateStatusBar();
        } else {
            this.statusBarItem.hide();
        }

        // Keep the selection valid: default to the newest file, and fall back
        // to it if the previously shown file was rotated away or deleted.
        if (!this.activeFile || !this.files.includes(this.activeFile)) {
            this.activeFile = this.files[0];
        }

        if (this.panel) {
            this.postFiles();
            await this.postContent();
        }
    }

    // ── Status bar / unread indicator ────────────────────────────────────────

    private setUnread(unread: boolean): void {
        if (this.hasUnread === unread) {
            return;
        }
        this.hasUnread = unread;
        this.updateStatusBar();
    }

    private updateStatusBar(): void {
        if (this.files.length === 0) {
            this.statusBarItem.hide();
            return;
        }
        // A small blue dot after the label is the "changed since last viewed"
        // hint. It is intentionally subtle and disappears as soon as the panel
        // is revealed.
        this.statusBarItem.text = this.hasUnread ? "$(output) Logs 🔵" : "$(output) Logs";
        this.statusBarItem.tooltip = this.hasUnread
            ? "PHPantom: Show logs (new entries since last viewed)"
            : "PHPantom: Show logs";
        this.statusBarItem.show();
    }

    // ── Panel lifecycle ──────────────────────────────────────────────────────

    private panelIsVisible(): boolean {
        return this.panel?.visible ?? false;
    }

    private async reveal(): Promise<void> {
        // Revealing the panel is the "I've seen it" signal.
        this.setUnread(false);

        if (this.files.length === 0) {
            await this.refreshFileList();
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Active);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            "phpantom.logViewer",
            "PHPantom Logs",
            { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
            { enableScripts: true, retainContextWhenHidden: true }
        );
        this.panel.webview.html = this.renderHtml(this.panel.webview);

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
        this.panel.onDidChangeViewState(() => {
            if (this.panel?.visible) {
                this.setUnread(false);
            }
        });
        this.panel.webview.onDidReceiveMessage((message: WebviewToExtension) => {
            void this.handleMessage(message);
        });
    }

    private async handleMessage(message: WebviewToExtension): Promise<void> {
        switch (message.type) {
            case "ready":
                this.postFiles();
                await this.postContent();
                return;
            case "selectFile":
                if (message.path && this.files.includes(message.path)) {
                    this.activeFile = message.path;
                    await this.postContent();
                }
                return;
            case "open":
                if (message.path) {
                    await this.openStackFrame(message.path, message.line ?? 1);
                }
                return;
        }
    }

    private postFiles(): void {
        this.panel?.webview.postMessage({
            type: "files",
            files: this.files.map((fsPath) => ({ path: fsPath, name: labelFor(fsPath) })),
            active: this.activeFile
        });
    }

    private async postContent(): Promise<void> {
        if (!this.panel || !this.activeFile) {
            return;
        }
        const filePath = this.activeFile;
        let text: string;
        try {
            text = await readTail(filePath);
        } catch {
            text = "";
        }
        // A late refresh must not clobber a file the user switched to meanwhile.
        if (this.activeFile === filePath) {
            this.panel.webview.postMessage({ type: "content", path: filePath, text });
        }
    }

    // ── Stack-frame click-through ────────────────────────────────────────────

    /**
     * Open the file referenced by a clicked stack frame at the given line.
     *
     * Laravel logs record absolute paths, which usually resolve directly. When
     * the log was produced in a different environment (a container, another
     * checkout), the absolute path will not exist locally, so fall back to
     * locating the file inside the workspace by its trailing path segments.
     */
    private async openStackFrame(rawPath: string, line: number): Promise<void> {
        const target = await resolveLogPath(rawPath);
        if (!target) {
            vscode.window.showWarningMessage(`PHPantom: could not locate ${rawPath}`);
            return;
        }

        const document = await vscode.workspace.openTextDocument(target);
        const editor = await vscode.window.showTextDocument(document, {
            viewColumn: vscode.ViewColumn.One,
            preview: true
        });
        const zeroBased = Math.max(0, line - 1);
        const position = new vscode.Position(zeroBased, 0);
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );
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
    <select id="file" title="Log file"></select>
    <select id="level" title="Minimum level">
        <option value="0">All levels</option>
        <option value="1">Debug+</option>
        <option value="2">Info+</option>
        <option value="3">Notice+</option>
        <option value="4">Warning+</option>
        <option value="5">Error+</option>
    </select>
    <input id="search" type="search" placeholder="Filter…" />
    <label class="toggle"><input id="wrap" type="checkbox" /> Wrap</label>
    <label class="toggle"><input id="follow" type="checkbox" checked /> Follow</label>
    <span id="count"></span>
</header>
<main id="log" class="nowrap"><div id="empty" class="empty">No log entries.</div></main>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>`;
    }
}

// ── Module-level helpers ─────────────────────────────────────────────────────

function isExcluded(fsPath: string): boolean {
    const normalized = fsPath.replace(/\\/g, "/");
    return normalized.includes("/vendor/") || normalized.includes("/node_modules/");
}

/** A short, disambiguating label: the file name, prefixed with its folder when needed. */
function labelFor(fsPath: string): string {
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(fsPath));
    if (folder && (vscode.workspace.workspaceFolders?.length ?? 0) > 1) {
        return `${folder.name}: ${path.basename(fsPath)}`;
    }
    return path.basename(fsPath);
}

async function mtimeOf(fsPath: string): Promise<number> {
    try {
        const stat = await fs.promises.stat(fsPath);
        return stat.mtimeMs;
    } catch {
        return 0;
    }
}

/** Read at most the last {@link MAX_TAIL_BYTES}/{@link MAX_TAIL_LINES} of a file. */
async function readTail(filePath: string): Promise<string> {
    const handle = await fs.promises.open(filePath, "r");
    try {
        const { size } = await handle.stat();
        const start = size > MAX_TAIL_BYTES ? size - MAX_TAIL_BYTES : 0;
        const length = size - start;
        if (length <= 0) {
            return "";
        }
        const buffer = Buffer.alloc(length);
        await handle.read(buffer, 0, length, start);
        let text = buffer.toString("utf8");

        // A byte offset can land mid-line; drop the partial first line so the
        // parser never sees a fragment masquerading as a fresh entry.
        if (start > 0) {
            const newline = text.indexOf("\n");
            text = newline >= 0 ? text.slice(newline + 1) : text;
        }

        const lines = text.split("\n");
        if (lines.length > MAX_TAIL_LINES) {
            return lines.slice(lines.length - MAX_TAIL_LINES).join("\n");
        }
        return text;
    } finally {
        await handle.close();
    }
}

/**
 * Resolve a path from a log line to an openable file: the absolute path if it
 * exists, otherwise a best-effort match on the trailing path segments inside
 * the workspace (handles logs produced in a container or another checkout).
 */
async function resolveLogPath(rawPath: string): Promise<vscode.Uri | undefined> {
    const normalized = rawPath.replace(/\\/g, "/");

    if (path.isAbsolute(rawPath) || /^[A-Za-z]:/.test(rawPath)) {
        if (await pathExists(rawPath)) {
            return vscode.Uri.file(rawPath);
        }
    }

    const base = path.posix.basename(normalized);
    if (!base) {
        return undefined;
    }
    const candidates = await vscode.workspace.findFiles(`**/${base}`, LOG_EXCLUDE, 50);
    if (candidates.length === 0) {
        return undefined;
    }
    // Prefer the candidate whose tail best matches the logged path (longest
    // common suffix of path segments), so `app/Foo.php` beats a stray `Foo.php`.
    const wanted = normalized.split("/").filter(Boolean);
    let best: vscode.Uri | undefined;
    let bestScore = -1;
    for (const candidate of candidates) {
        const have = candidate.fsPath.replace(/\\/g, "/").split("/").filter(Boolean);
        let score = 0;
        while (
            score < wanted.length &&
            score < have.length &&
            wanted[wanted.length - 1 - score] === have[have.length - 1 - score]
        ) {
            score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = candidate;
        }
    }
    return best;
}

async function pathExists(fsPath: string): Promise<boolean> {
    try {
        await fs.promises.access(fsPath);
        return true;
    } catch {
        return false;
    }
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
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 13px);
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
    font-family: var(--vscode-font-family);
    font-size: 12px;
}
header select, header input[type="search"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    padding: 2px 4px;
    border-radius: 3px;
    font-size: 12px;
}
header input[type="search"] { flex: 1 1 auto; min-width: 80px; }
header .toggle { display: inline-flex; align-items: center; gap: 3px; white-space: nowrap; }
#count { color: var(--vscode-descriptionForeground); white-space: nowrap; }
main {
    flex: 1 1 auto;
    overflow: auto;
    padding: 4px 0;
}
main.nowrap .entry { white-space: pre; }
main .entry { white-space: pre-wrap; }
.entry {
    padding: 1px 10px;
    border-left: 3px solid transparent;
}
.entry:hover { background: var(--vscode-list-hoverBackground); }
.entry .time { color: var(--vscode-descriptionForeground); }
.entry .chan { color: var(--vscode-descriptionForeground); }
.entry .level {
    font-weight: 600;
    padding: 0 4px;
    border-radius: 3px;
}
.entry.lvl-error { border-left-color: var(--vscode-editorError-foreground, #f14c4c); }
.entry.lvl-error .level { color: var(--vscode-editorError-foreground, #f14c4c); }
.entry.lvl-warn { border-left-color: var(--vscode-editorWarning-foreground, #cca700); }
.entry.lvl-warn .level { color: var(--vscode-editorWarning-foreground, #cca700); }
.entry.lvl-info { border-left-color: var(--vscode-editorInfo-foreground, #3794ff); }
.entry.lvl-info .level { color: var(--vscode-editorInfo-foreground, #3794ff); }
.entry.lvl-debug { border-left-color: transparent; }
.entry.lvl-debug .level { color: var(--vscode-descriptionForeground); }
.entry details { margin-top: 1px; }
.entry summary { cursor: pointer; list-style: revert; }
.entry .detail { color: var(--vscode-descriptionForeground); }
a.frame {
    color: var(--vscode-textLink-foreground);
    cursor: pointer;
    text-decoration: none;
}
a.frame:hover { text-decoration: underline; }
.empty { padding: 12px; color: var(--vscode-descriptionForeground); }
`;

const SCRIPT = `
const vscode = acquireVsCodeApi();
const logEl = document.getElementById("log");
const fileEl = document.getElementById("file");
const levelEl = document.getElementById("level");
const searchEl = document.getElementById("search");
const wrapEl = document.getElementById("wrap");
const followEl = document.getElementById("follow");
const countEl = document.getElementById("count");

let entries = [];

const LEVEL_RANK = {
    DEBUG: 1, INFO: 2, NOTICE: 3, WARNING: 4,
    ERROR: 5, CRITICAL: 5, ALERT: 5, EMERGENCY: 5
};
const LEVEL_CLASS = {
    DEBUG: "lvl-debug", INFO: "lvl-info", NOTICE: "lvl-info", WARNING: "lvl-warn",
    ERROR: "lvl-error", CRITICAL: "lvl-error", ALERT: "lvl-error", EMERGENCY: "lvl-error"
};
const HEADER_RE = /^\\[(\\d{4}-\\d{2}-\\d{2}[ T]\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?(?:[+-]\\d{2}:?\\d{2})?)\\]\\s+([^\\s]+?)\\.([A-Z]+):\\s?([\\s\\S]*)$/;
// A filesystem path immediately followed by (line): the PHP/Laravel trace shape.
const FRAME_RE = /((?:\\/|[A-Za-z]:\\\\)[^\\s():]+(?:[\\/\\\\][^\\s():]+)*)\\((\\d+)\\)/g;

function escapeHtml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function linkify(text) {
    let result = "";
    let last = 0;
    let match;
    FRAME_RE.lastIndex = 0;
    while ((match = FRAME_RE.exec(text)) !== null) {
        result += escapeHtml(text.slice(last, match.index));
        const p = escapeHtml(match[1]);
        result += '<a class="frame" data-path="' + p + '" data-line="' + match[2] + '">' + escapeHtml(match[0]) + "</a>";
        last = match.index + match[0].length;
    }
    result += escapeHtml(text.slice(last));
    return result;
}

function parse(text) {
    const lines = text.split("\\n");
    const out = [];
    let current = null;
    for (const line of lines) {
        const m = HEADER_RE.exec(line);
        if (m) {
            current = {
                time: m[1],
                channel: m[2],
                level: m[3].toUpperCase(),
                message: m[4],
                detail: []
            };
            out.push(current);
        } else if (current) {
            current.detail.push(line);
        } else if (line.length > 0) {
            current = { time: "", channel: "", level: "", message: line, detail: [] };
            out.push(current);
        }
    }
    return out;
}

function render() {
    const minRank = parseInt(levelEl.value, 10) || 0;
    const needle = searchEl.value.trim().toLowerCase();
    logEl.classList.toggle("nowrap", !wrapEl.checked);

    const parts = [];
    let shown = 0;

    for (const e of entries) {
        const rank = LEVEL_RANK[e.level] || 0;
        if (minRank > 0 && rank > 0 && rank < minRank) { continue; }
        if (needle) {
            const hay = (e.message + " " + e.detail.join(" ") + " " + e.level + " " + e.channel).toLowerCase();
            if (hay.indexOf(needle) === -1) { continue; }
        }
        shown++;
        parts.push(renderEntry(e));
    }

    if (shown === 0) {
        logEl.innerHTML = '<div class="empty">No matching log entries.</div>';
    } else {
        logEl.innerHTML = parts.join("");
    }
    countEl.textContent = shown + (shown === 1 ? " entry" : " entries");

    if (followEl.checked) {
        logEl.scrollTop = logEl.scrollHeight;
    }
}

function renderEntry(e) {
    const cls = LEVEL_CLASS[e.level] || "lvl-debug";
    let head = '<div class="entry ' + cls + '">';
    if (e.time) {
        head += '<span class="time">[' + escapeHtml(e.time) + "] </span>";
        head += '<span class="chan">' + escapeHtml(e.channel) + ".</span>";
        head += '<span class="level">' + escapeHtml(e.level) + "</span> ";
    }
    head += '<span class="msg">' + linkify(e.message) + "</span>";
    const detail = e.detail.filter((l) => l.length > 0);
    if (detail.length > 0) {
        head += '<details><summary>' + detail.length + (detail.length === 1 ? " more line" : " more lines") + '</summary>';
        head += '<div class="detail">' + detail.map(linkify).join("\\n") + "</div></details>";
    }
    head += "</div>";
    return head;
}

logEl.addEventListener("click", (event) => {
    const target = event.target.closest("a.frame");
    if (target) {
        event.preventDefault();
        vscode.postMessage({
            type: "open",
            path: target.getAttribute("data-path"),
            line: parseInt(target.getAttribute("data-line"), 10)
        });
    }
});

fileEl.addEventListener("change", () => {
    vscode.postMessage({ type: "selectFile", path: fileEl.value });
});
levelEl.addEventListener("change", render);
searchEl.addEventListener("input", render);
wrapEl.addEventListener("change", render);
followEl.addEventListener("change", render);

window.addEventListener("message", (event) => {
    const msg = event.data;
    if (msg.type === "files") {
        fileEl.innerHTML = "";
        for (const f of msg.files) {
            const opt = document.createElement("option");
            opt.value = f.path;
            opt.textContent = f.name;
            if (f.path === msg.active) { opt.selected = true; }
            fileEl.appendChild(opt);
        }
    } else if (msg.type === "content") {
        entries = parse(msg.text);
        render();
    }
});

vscode.postMessage({ type: "ready" });
`;
