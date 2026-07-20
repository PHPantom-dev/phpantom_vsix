import * as fs from "fs";
import * as path from "path";

// ── composer.json PSR-4 autoload parsing ─────────────────────────────────────
//
// The Laravel file generation feature needs to map between directories,
// namespaces, and file paths the way Laravel's own generators do: to pre-fill a
// namespace from a clicked explorer folder, and to resolve where a generated
// class file will land (for opening it, and for the bundled-template fallback
// when artisan cannot boot). All three need the project's PSR-4 roots.
//
// This is deliberately a small, self-contained reader. It never runs the app,
// and nothing it produces is fed back into the language server; it only informs
// the extension's own generation UI.

/** A single PSR-4 autoload mapping: a namespace prefix and the directory it maps to. */
export interface Psr4Root {
    /** The namespace prefix without a trailing separator, e.g. `App`. */
    namespace: string;
    /** The absolute directory the prefix maps to, e.g. `/project/app`. */
    directory: string;
}

/**
 * Read the PSR-4 autoload roots declared in a folder's `composer.json`, merging
 * the `autoload` and `autoload-dev` sections. Returns an empty list when the
 * file is missing or unparsable, so callers degrade to no pre-fill rather than
 * failing. Roots are sorted with the longest namespace first so the most
 * specific prefix wins when several would match.
 */
export function loadPsr4Roots(folderFsPath: string): Psr4Root[] {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(folderFsPath, "composer.json"), "utf8");
    } catch {
        return [];
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }
    if (typeof parsed !== "object" || parsed === null) {
        return [];
    }

    const record = parsed as Record<string, unknown>;
    const roots: Psr4Root[] = [];
    for (const section of ["autoload", "autoload-dev"]) {
        const auto = record[section];
        if (typeof auto !== "object" || auto === null) {
            continue;
        }
        const psr4 = (auto as Record<string, unknown>)["psr-4"];
        if (typeof psr4 !== "object" || psr4 === null) {
            continue;
        }
        for (const [namespace, directory] of Object.entries(psr4 as Record<string, unknown>)) {
            const dir = firstDirectory(directory);
            if (dir === undefined) {
                continue;
            }
            roots.push({
                namespace: namespace.replace(/\\+$/, ""),
                directory: path.resolve(folderFsPath, dir)
            });
        }
    }

    roots.sort((a, b) => b.namespace.length - a.namespace.length);
    return roots;
}

/** A PSR-4 mapping may point at a single directory or a list of them; take the first. */
function firstDirectory(value: unknown): string | undefined {
    if (typeof value === "string") {
        return value;
    }
    if (Array.isArray(value)) {
        const first = value.find((entry) => typeof entry === "string");
        return typeof first === "string" ? first : undefined;
    }
    return undefined;
}

/**
 * The namespace a directory lives in, according to the PSR-4 roots (e.g.
 * `/project/app/Models` → `App\Models`). Returns `undefined` when the directory
 * is not under any root. When several roots contain the directory, the deepest
 * (longest directory) wins so a nested root is preferred over its parent.
 */
export function directoryToNamespace(roots: Psr4Root[], dirFsPath: string): string | undefined {
    const target = path.resolve(dirFsPath);

    let best: Psr4Root | undefined;
    for (const root of roots) {
        if (isInside(root.directory, target) && (!best || root.directory.length > best.directory.length)) {
            best = root;
        }
    }
    if (!best) {
        return undefined;
    }

    const relative = path.relative(best.directory, target);
    if (relative === "") {
        return best.namespace;
    }
    const suffix = relative.split(path.sep).join("\\");
    return best.namespace ? `${best.namespace}\\${suffix}` : suffix;
}

/**
 * The file a fully-qualified class name maps to under the PSR-4 roots (e.g.
 * `App\Models\Post` → `/project/app/Models/Post.php`). Returns `undefined` when
 * no root's namespace prefixes the class.
 */
export function fqnToFilePath(roots: Psr4Root[], fqn: string): string | undefined {
    const normalized = fqn.replace(/^\\+/, "");

    for (const root of roots) {
        if (root.namespace === "") {
            return path.join(root.directory, `${normalized.split("\\").join(path.sep)}.php`);
        }
        const prefix = `${root.namespace}\\`;
        if (normalized.startsWith(prefix)) {
            const relative = normalized.slice(prefix.length).split("\\").join(path.sep);
            return path.join(root.directory, `${relative}.php`);
        }
    }
    return undefined;
}

/**
 * The application's root namespace, i.e. the PSR-4 namespace mapped to the `app/`
 * directory (`App` in a default Laravel install). This mirrors Laravel's
 * `$app->getNamespace()`, which the `make:*` commands use to qualify names.
 * Falls back to `App` when no mapping points at `app/`.
 */
export function appRootNamespace(roots: Psr4Root[], folderFsPath: string): string {
    const appDir = path.resolve(folderFsPath, "app");
    for (const root of roots) {
        if (path.resolve(root.directory) === appDir) {
            return root.namespace;
        }
    }
    return "App";
}

/** Whether `child` is `parent` itself or nested inside it. */
function isInside(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
