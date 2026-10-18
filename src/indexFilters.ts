import * as path from "path";
import * as vscode from "vscode";

/**
 * The file-filter block PHPantom accepts from a client, as
 * `initializationOptions` at startup and as the `settings` of a
 * `workspace/didChangeConfiguration` notification afterwards.
 *
 * The server merges these with the project's own `.phpantom.toml`
 * `[indexing]` settings rather than letting either side win, so a folder
 * hidden in either place stays out of the index.
 */
export interface IndexFilterOptions {
    indexing: {
        exclude: string[];
        extensions: string[];
    };
}

/**
 * Derive PHPantom's file filters from the editor's own settings for one
 * workspace folder.
 *
 * VS Code already knows which folders the user hides (`files.exclude`)
 * and which extensions they open as PHP (`files.associations`); without
 * this the same lists have to be mirrored into `.phpantom.toml` by hand.
 * Configuration is read folder-scoped because clients are spawned one per
 * workspace folder, and `files.exclude` is commonly overridden per folder
 * in a multi-root workspace.
 */
export function collectIndexFilters(
    folder: vscode.WorkspaceFolder | undefined
): IndexFilterOptions {
    const scope = folder?.uri;

    const excludeSetting = vscode.workspace
        .getConfiguration("files", scope)
        .get<Record<string, boolean | { when?: string }>>("exclude", {});
    const associationsSetting = vscode.workspace
        .getConfiguration("files", scope)
        .get<Record<string, string>>("associations", {});

    // `folder` is where the server is rooted, which `phpantom.rootDir` can
    // move below the workspace folder these settings belong to. The globs
    // are relative to the workspace folder, the server reads them relative
    // to its root.
    const workspaceFolder = folder && vscode.workspace.getWorkspaceFolder(folder.uri);
    const root = folder && workspaceFolder
        ? path.relative(workspaceFolder.uri.fsPath, folder.uri.fsPath).split(path.sep).join("/")
        : "";

    const exclude: string[] = [];
    for (const [pattern, enabled] of Object.entries(excludeSetting)) {
        // A `{ "when": "$(basename).ts" }` value hides a file only while a
        // sibling exists. That is a per-file question the server cannot
        // answer from a glob, and guessing would drop real source from the
        // index, so those entries are left to `.phpantom.toml`.
        if (enabled !== true) {
            continue;
        }
        exclude.push(...toGitignorePatterns(pattern, root));
    }

    const extensions: string[] = [];
    for (const [pattern, languageId] of Object.entries(associationsSetting)) {
        if (languageId !== "php") {
            continue;
        }
        const extension = toFileExtension(pattern);
        if (extension && !extensions.includes(extension)) {
            extensions.push(extension);
        }
    }

    return { indexing: { exclude, extensions } };
}

/**
 * Translate one `files.exclude` glob into the gitignore lines PHPantom
 * accepts, yielding more than one when the glob uses a brace group.
 *
 * The two dialects overlap almost entirely (`**` and `?` mean the same
 * thing in both), so this handles only the three places they diverge.
 *
 * `root` is the server's root relative to the workspace folder, with
 * forward slashes: empty unless `phpantom.rootDir` moved it.
 */
export function toGitignorePatterns(pattern: string, root = ""): string[] {
    const trimmed = pattern.trim();
    if (!trimmed) {
        return [];
    }

    return expandBraces(trimmed)
        .map((expanded) => relativeToRoot(expanded, root))
        .filter((relative): relative is string => relative !== undefined)
        .map(normalizeGitignorePattern)
        .filter((normalized): normalized is string => normalized !== undefined);
}

/**
 * Re-anchor a glob written against the workspace folder onto `root`, or
 * `undefined` when it cannot match anything inside `root`.
 *
 * A glob starting with `**` matches at any depth, so it is kept as is: from
 * `root` it can only match less than it did from the folder. Any other glob
 * is anchored at the folder, so a literal `root/` prefix is stripped, and a
 * glob that lies outside `root`, reaches it only through a wildcard, or
 * would hide `root` itself (the user pointed the server there on purpose)
 * is dropped. Leaving a directory in the index costs a parse, while hiding
 * one the user did not hide costs its symbols, so this errs towards
 * dropping rather than matching wildcards segment by segment.
 */
function relativeToRoot(pattern: string, root: string): string | undefined {
    if (!root || pattern === "**" || pattern.startsWith("**/")) {
        return pattern;
    }

    if (!pattern.startsWith(`${root}/`)) {
        return undefined;
    }

    const relative = pattern.slice(root.length + 1);
    return relative === "" || relative === "**" ? undefined : relative;
}

function normalizeGitignorePattern(pattern: string): string | undefined {
    // `out/**` excludes everything under `out`. Gitignore reads that the
    // same way but keeps walking into the directory to test each child;
    // naming the directory itself lets the walker prune it instead.
    let normalized = pattern.endsWith("/**") ? pattern.slice(0, -3) : pattern;
    if (!normalized) {
        return undefined;
    }

    // A VS Code glob is relative to the workspace folder, so a
    // single-segment `node_modules` means the one at the root. Gitignore
    // reads a slashless pattern as matching at any depth, so it needs an
    // explicit anchor to keep the narrower meaning. Patterns that already
    // contain a slash (including the `**/` the VS Code defaults use to ask
    // for any depth) carry the same meaning in both dialects.
    if (!normalized.includes("/")) {
        normalized = `/${normalized}`;
    }

    // `!` and `#` lead a negation and a comment in gitignore, but are
    // ordinary characters in a VS Code glob. Only the first character of
    // the line carries that meaning, so this is checked after anchoring:
    // a pattern that just gained a leading `/` needs no escape.
    if (normalized.startsWith("!") || normalized.startsWith("#")) {
        normalized = `\\${normalized}`;
    }

    return normalized;
}

/**
 * Expand a glob's brace groups into one pattern per alternative.
 *
 * VS Code's dialect supports `{a,b}`; gitignore has no equivalent, so a
 * grouped exclude has to become one line per alternative.
 */
function expandBraces(pattern: string): string[] {
    const open = pattern.indexOf("{");
    if (open === -1) {
        return [pattern];
    }

    // Find this group's matching close brace, skipping over nested groups.
    let depth = 0;
    let close = -1;
    for (let i = open; i < pattern.length; i++) {
        if (pattern[i] === "{") {
            depth++;
        } else if (pattern[i] === "}") {
            depth--;
            if (depth === 0) {
                close = i;
                break;
            }
        }
    }
    if (close === -1) {
        // Unbalanced, so there is nothing to expand. Pass it through and
        // let the server's own glob compiler reject it with a warning.
        return [pattern];
    }

    const before = pattern.slice(0, open);
    const after = pattern.slice(close + 1);
    const alternatives = splitTopLevel(pattern.slice(open + 1, close));

    return alternatives.flatMap((alternative) =>
        expandBraces(`${before}${alternative}${after}`)
    );
}

/** Split a brace group's body on its own commas, ignoring nested groups. */
function splitTopLevel(body: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = "";

    for (const character of body) {
        if (character === "{") {
            depth++;
        } else if (character === "}") {
            depth--;
        }

        if (character === "," && depth === 0) {
            parts.push(current);
            current = "";
            continue;
        }
        current += character;
    }
    parts.push(current);

    return parts;
}

/**
 * Reduce a `files.associations` glob to the bare extension PHPantom
 * indexes by, or `undefined` when it does not name one.
 *
 * `*.module` gives `module`, with or without an any-depth prefix.
 * Patterns that name a whole file (`Jenkinsfile`), or that would need more
 * than an extension to express (`*.blade.php`), have no equivalent: the
 * server's extension list is a set of bare extensions, so anything else is
 * left to `.phpantom.toml`.
 *
 * A pattern that restricts the association to a subtree (`src/*.inc`)
 * contributes its extension workspace-wide, since that list has no path
 * dimension. Indexing a few extra files of a type the user already treats
 * as PHP costs a parse; missing them costs the symbols in them.
 */
export function toFileExtension(pattern: string): string | undefined {
    const lastSegment = pattern.trim().split("/").pop();
    if (!lastSegment) {
        return undefined;
    }

    const match = /^\*\.([A-Za-z0-9_-]+)$/.exec(lastSegment);
    if (!match) {
        return undefined;
    }

    const extension = match[1].toLowerCase();
    // `.php` is always indexed, so forwarding it is noise.
    return extension === "php" ? undefined : extension;
}
