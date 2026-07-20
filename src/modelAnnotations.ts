import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
    ArtisanContext,
    findArtisanContexts,
    pickArtisanContext,
    runArtisanCapture
} from "./artisan";

// ── V9: Model @property annotation generation ────────────────────────────────
//
// Boots the Laravel application once via a bundled `artisan tinker` script
// (reusing the shared artisan runner) to read each Eloquent model's columns
// from the live database connection, then writes them as `@property` docblocks
// on the model class. This is the sanctioned way to close the "column types
// from a live database connection" gap: the language server stays purely
// static, and this one-time boot happens only when the user asks for it.
//
// Output is `@property` only. No `@mixin` (the server already infers builder
// and query methods statically) and no dependency on laravel-ide-helper. Model
// `$casts` are honoured so the annotations match the runtime type the developer
// sees (e.g. a `datetime` cast becomes a Carbon type, a `bool` cast becomes
// `bool`), which is the work the bundled tinker script performs.

/** A single column mapped to a PHP type, as returned by the tinker script. */
interface GeneratedProperty {
    /** The column name, used as the `$name` in the `@property` tag. */
    name: string;
    /** The resolved PHP type string, e.g. `int`, `string|null`, `\Illuminate\Support\Carbon`. */
    type: string;
}

/** One Eloquent model discovered and introspected by the tinker script. */
interface GeneratedModel {
    /** Fully-qualified class name of the model. */
    class: string;
    /** Absolute path to the model's source file. */
    file: string;
    /** The `@property` entries, in column order. */
    properties: GeneratedProperty[];
}

/** The full JSON payload the tinker script prints between its markers. */
interface GenerationPayload {
    /** Every model that was successfully introspected. */
    models: GeneratedModel[];
    /** Per-model failures (e.g. an unreachable database), for the output log. */
    errors: string[];
}

// The tinker script wraps its JSON in these markers so it can be extracted from
// PsySH's surrounding output (banners, `=> ...` echoes, warnings).
const MARKER_START = "===PHPANTOM_MODELS_START===";
const MARKER_END = "===PHPANTOM_MODELS_END===";

// Booting the app, scanning `app/`, and querying the database for every model
// can take a while on a large project, so allow longer than the runner default.
const TINKER_TIMEOUT_MS = 120_000;

/** How the user resolved a per-model overwrite prompt, remembered across models. */
interface OverwriteDecision {
    /** Overwrite every remaining model's existing `@property` tags without asking. */
    all: boolean;
    /** Skip every remaining model that already has `@property` tags. */
    skipAll: boolean;
}

/**
 * Register the model annotation generation commands. The "generate" variant
 * prompts before replacing hand-written `@property` tags; the "regenerate"
 * variant overwrites them without prompting, for refreshing annotations after
 * migrations run. The returned disposables are owned by the extension context.
 */
export function registerModelAnnotationCommands(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
): void {
    context.subscriptions.push(
        vscode.commands.registerCommand("phpantom.generateModelAnnotations", () =>
            runGeneration(context, outputChannel, false)
        ),
        vscode.commands.registerCommand("phpantom.regenerateModelAnnotations", () =>
            runGeneration(context, outputChannel, true)
        )
    );
}

/** Drive the full boot → introspect → write flow for one command invocation. */
async function runGeneration(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    regenerate: boolean
): Promise<void> {
    const contexts = findArtisanContexts();
    if (contexts.length === 0) {
        vscode.window.showInformationMessage(
            "No Laravel application was found. PHPantom looks for an artisan script in each open workspace folder."
        );
        return;
    }

    const artisanContext = await pickArtisanContext(contexts);
    if (!artisanContext) {
        return;
    }

    const payload = await introspectModels(context, artisanContext, outputChannel);
    if (!payload) {
        return;
    }

    for (const error of payload.errors) {
        outputChannel.appendLine(`Model annotation skipped: ${error}`);
    }

    if (payload.models.length === 0) {
        vscode.window.showInformationMessage(
            "PHPantom found no Eloquent models with database columns to annotate."
        );
        return;
    }

    await writeAnnotations(payload.models, regenerate, outputChannel);
}

/**
 * Run the bundled tinker script and parse its JSON payload. Surfaces a helpful
 * message (and logs details) when PHP cannot be spawned, the app fails to boot,
 * or the output cannot be parsed, returning `undefined` in every failure case.
 */
async function introspectModels(
    context: vscode.ExtensionContext,
    artisanContext: ArtisanContext,
    outputChannel: vscode.OutputChannel
): Promise<GenerationPayload | undefined> {
    let script: string;
    try {
        script = loadTinkerScript(context);
    } catch (error) {
        vscode.window.showErrorMessage("PHPantom could not load its model annotation script.");
        outputChannel.appendLine(`Failed to read the model annotation script: ${formatError(error)}`);
        return undefined;
    }

    const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Reading model columns from the database…" },
        () => runArtisanCapture(artisanContext, ["tinker"], { stdin: script, timeoutMs: TINKER_TIMEOUT_MS })
    );

    if (result.spawnError) {
        vscode.window.showErrorMessage(
            `PHPantom could not run PHP (${artisanContext.php}). Set phpantom.phpPath to a PHP executable, or install PHP on your PATH.`
        );
        outputChannel.appendLine(`Model annotation tinker run failed to spawn: ${result.spawnError.message}`);
        return undefined;
    }

    const payload = parsePayload(result.stdout);
    if (!payload) {
        vscode.window.showWarningMessage(
            "PHPantom could not read model columns. The application may have failed to boot, or the database may be unreachable. See the PHPantom output for details."
        );
        outputChannel.appendLine(
            `Unexpected tinker output (exit ${result.exitCode ?? "signal"}):\n${(result.stderr || result.stdout).slice(0, 4000)}`
        );
        return undefined;
    }

    return payload;
}

/** Read the bundled tinker script and strip its `<?php` tag for stdin. */
function loadTinkerScript(context: vscode.ExtensionContext): string {
    const scriptPath = path.join(context.extensionPath, "resources", "generate-model-annotations.php");
    const source = fs.readFileSync(scriptPath, "utf8");
    // PsySH reads raw PHP statements from stdin, without an opening tag.
    return source.replace(/^\uFEFF?\s*<\?php\s*/, "");
}

/** Extract and parse the JSON payload wrapped in the script's markers. */
function parsePayload(stdout: string): GenerationPayload | undefined {
    const start = stdout.indexOf(MARKER_START);
    const end = stdout.indexOf(MARKER_END, start + MARKER_START.length);
    if (start === -1 || end === -1) {
        return undefined;
    }

    const json = stdout.slice(start + MARKER_START.length, end);
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return undefined;
    }

    if (typeof parsed !== "object" || parsed === null) {
        return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const rawModels = Array.isArray(record.models) ? record.models : [];
    const rawErrors = Array.isArray(record.errors) ? record.errors : [];

    const models: GeneratedModel[] = [];
    for (const raw of rawModels) {
        const model = parseModel(raw);
        if (model) {
            models.push(model);
        }
    }

    const errors = rawErrors.filter((error): error is string => typeof error === "string");
    return { models, errors };
}

/** Validate and normalise a single model entry from the JSON payload. */
function parseModel(raw: unknown): GeneratedModel | undefined {
    if (typeof raw !== "object" || raw === null) {
        return undefined;
    }
    const record = raw as Record<string, unknown>;
    const className = typeof record.class === "string" ? record.class : undefined;
    const file = typeof record.file === "string" ? record.file : undefined;
    if (!className || !file || !Array.isArray(record.properties)) {
        return undefined;
    }

    const properties: GeneratedProperty[] = [];
    for (const entry of record.properties) {
        if (typeof entry !== "object" || entry === null) {
            continue;
        }
        const propertyRecord = entry as Record<string, unknown>;
        const name = typeof propertyRecord.name === "string" ? propertyRecord.name : undefined;
        const type = typeof propertyRecord.type === "string" ? propertyRecord.type : undefined;
        if (name && type) {
            properties.push({ name, type });
        }
    }

    if (properties.length === 0) {
        return undefined;
    }
    return { class: className, file, properties };
}

/**
 * Apply the generated `@property` docblocks to every model, prompting before
 * overwriting existing annotations unless `regenerate` is set. Reports a summary
 * of what was updated and skipped.
 */
async function writeAnnotations(
    models: GeneratedModel[],
    regenerate: boolean,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const edit = new vscode.WorkspaceEdit();
    const decision: OverwriteDecision = { all: false, skipAll: false };
    let updated = 0;
    let skipped = 0;
    let failed = 0;

    for (const model of models) {
        const shortName = model.class.split("\\").pop() ?? model.class;

        let document: vscode.TextDocument;
        try {
            document = await vscode.workspace.openTextDocument(vscode.Uri.file(model.file));
        } catch (error) {
            failed++;
            outputChannel.appendLine(`Could not open ${model.file}: ${formatError(error)}`);
            continue;
        }

        const analysis = analyzeClassDocblock(document, shortName);
        if (!analysis) {
            failed++;
            outputChannel.appendLine(`Could not locate class ${shortName} in ${model.file}.`);
            continue;
        }

        if (analysis.existingPropertyLines > 0 && !regenerate) {
            const proceed = await resolveOverwrite(shortName, decision);
            if (!proceed) {
                skipped++;
                continue;
            }
        }

        applyModelEdit(edit, document, model, analysis);
        updated++;
    }

    if (updated > 0) {
        await vscode.workspace.applyEdit(edit);
    }

    reportSummary(updated, skipped, failed);
}

/**
 * Decide whether to overwrite a model's existing annotations, prompting the user
 * and honouring a previously chosen "all"/"skip all". Returns whether to proceed.
 */
async function resolveOverwrite(shortName: string, decision: OverwriteDecision): Promise<boolean> {
    if (decision.all) {
        return true;
    }
    if (decision.skipAll) {
        return false;
    }

    const choice = await vscode.window.showWarningMessage(
        `${shortName} already has @property annotations. Overwrite them?`,
        "Overwrite",
        "Overwrite All",
        "Skip",
        "Skip All"
    );

    switch (choice) {
        case "Overwrite All":
            decision.all = true;
            return true;
        case "Overwrite":
            return true;
        case "Skip All":
            decision.skipAll = true;
            return false;
        default:
            // "Skip" or a dismissed prompt leaves this model untouched.
            return false;
    }
}

/** The result of locating a class and its docblock in a model file. */
interface DocblockAnalysis {
    /** Zero-based line index of the `class` declaration. */
    classLine: number;
    /** Leading whitespace of the class line, reused for the docblock lines. */
    indent: string;
    /** The existing class docblock, or `undefined` when the class has none. */
    docblock?: {
        /** Zero-based line index of the `/**` opening line. */
        startLine: number;
        /** Zero-based line index of the docblock's closing line. */
        endLine: number;
        /** Docblock content with the opening, closing, and leading ` * ` markers removed. */
        innerLines: string[];
    };
    /** Number of `@property` (incl. `-read`/`-write`) lines already present. */
    existingPropertyLines: number;
}

const PROPERTY_TAG = /^@property(-read|-write)?\b/;

/**
 * Locate the model's class declaration and its immediately preceding docblock
 * (skipping any attribute lines between them). Returns `undefined` when the
 * class cannot be found in the file.
 */
function analyzeClassDocblock(
    document: vscode.TextDocument,
    shortName: string
): DocblockAnalysis | undefined {
    const classPattern = new RegExp(`(^|\\s)class\\s+${escapeRegExp(shortName)}\\b`);
    let classLine = -1;
    for (let line = 0; line < document.lineCount; line++) {
        if (classPattern.test(document.lineAt(line).text)) {
            classLine = line;
            break;
        }
    }
    if (classLine === -1) {
        return undefined;
    }

    const indent = document.lineAt(classLine).text.match(/^\s*/)?.[0] ?? "";

    // A class docblock sits directly above the class, or above the class's
    // attributes when present. Skip attribute lines, but not blank lines, so an
    // unrelated file-level docblock separated by a blank line is not captured.
    let cursor = classLine - 1;
    while (cursor >= 0 && document.lineAt(cursor).text.trim().startsWith("#[")) {
        cursor--;
    }

    let docblock: DocblockAnalysis["docblock"];
    let existingPropertyLines = 0;
    if (cursor >= 0 && document.lineAt(cursor).text.trim().endsWith("*/")) {
        const endLine = cursor;
        let startLine = endLine;
        while (startLine >= 0 && !document.lineAt(startLine).text.trim().startsWith("/**")) {
            startLine--;
        }
        if (startLine >= 0) {
            const innerLines = extractDocblockInner(document, startLine, endLine);
            existingPropertyLines = innerLines.filter((text) => PROPERTY_TAG.test(text.trim())).length;
            docblock = { startLine, endLine, innerLines };
        }
    }

    return { classLine, indent, docblock, existingPropertyLines };
}

/**
 * Extract a docblock's content between its opening and closing lines, stripping the
 * per-line ` * ` markers so the text can be re-emitted with fresh markers.
 */
function extractDocblockInner(
    document: vscode.TextDocument,
    startLine: number,
    endLine: number
): string[] {
    const inner: string[] = [];

    for (let line = startLine; line <= endLine; line++) {
        let text = document.lineAt(line).text.trim();
        if (line === startLine) {
            text = text.replace(/^\/\*\*/, "");
        }
        if (line === endLine) {
            text = text.replace(/\*\/\s*$/, "");
        }
        text = text.replace(/^\*\s?/, "").trimEnd();
        // Drop the empty fragments left by a lone opening or closing marker on its own line.
        if ((line === startLine || line === endLine) && text.trim() === "") {
            continue;
        }
        inner.push(text);
    }

    return inner;
}

/**
 * Add the edit that writes `model`'s `@property` block into `document`, either
 * merging into the existing class docblock or inserting a new one above the
 * class (and its attributes).
 */
function applyModelEdit(
    edit: vscode.WorkspaceEdit,
    document: vscode.TextDocument,
    model: GeneratedModel,
    analysis: DocblockAnalysis
): void {
    const propertyLines = model.properties.map((property) => `@property ${property.type} $${property.name}`);

    if (analysis.docblock) {
        const merged = mergePropertyLines(analysis.docblock.innerLines, propertyLines);
        const text = renderDocblock(analysis.indent, merged);
        const range = new vscode.Range(
            analysis.docblock.startLine,
            0,
            analysis.docblock.endLine,
            document.lineAt(analysis.docblock.endLine).text.length
        );
        edit.replace(document.uri, range, text);
        return;
    }

    // No existing docblock: insert one directly above the class's attributes,
    // or above the class itself when it has none.
    let insertLine = analysis.classLine;
    while (insertLine - 1 >= 0 && document.lineAt(insertLine - 1).text.trim().startsWith("#[")) {
        insertLine--;
    }
    const text = renderDocblock(analysis.indent, propertyLines) + "\n";
    edit.insert(document.uri, new vscode.Position(insertLine, 0), text);
}

/**
 * Merge fresh `@property` lines into a docblock's existing content, replacing any
 * old `@property` lines in place and preserving the description and other tags.
 */
function mergePropertyLines(innerLines: string[], propertyLines: string[]): string[] {
    const isProperty = (text: string) => PROPERTY_TAG.test(text.trim());

    const firstProperty = innerLines.findIndex(isProperty);
    const kept = innerLines.filter((text) => !isProperty(text));
    const insertAt =
        firstProperty === -1
            ? kept.length
            : innerLines.slice(0, firstProperty).filter((text) => !isProperty(text)).length;

    const merged = [...kept.slice(0, insertAt), ...propertyLines, ...kept.slice(insertAt)];
    return trimBlankEdges(merged);
}

/** Drop leading and trailing blank lines so the rendered docblock is tidy. */
function trimBlankEdges(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;
    while (start < end && lines[start].trim() === "") {
        start++;
    }
    while (end > start && lines[end - 1].trim() === "") {
        end--;
    }
    return lines.slice(start, end);
}

/** Render inner docblock lines back into a `/** ... *​/` block at `indent`. */
function renderDocblock(indent: string, innerLines: string[]): string {
    const body = innerLines.map((text) => (text === "" ? `${indent} *` : `${indent} * ${text}`));
    return [`${indent}/**`, ...body, `${indent} */`].join("\n");
}

/** Report the outcome of a generation run to the user. */
function reportSummary(updated: number, skipped: number, failed: number): void {
    if (updated === 0 && failed === 0) {
        vscode.window.showInformationMessage("PHPantom did not change any model annotations.");
        return;
    }

    const parts = [`Annotated ${updated} model${updated === 1 ? "" : "s"}`];
    if (skipped > 0) {
        parts.push(`skipped ${skipped}`);
    }
    if (failed > 0) {
        parts.push(`${failed} could not be updated (see PHPantom output)`);
    }
    const message = `${parts.join(", ")}. Review and save the changes.`;

    if (failed > 0) {
        vscode.window.showWarningMessage(message);
    } else {
        vscode.window.showInformationMessage(message);
    }
}

/** Escape a string for safe embedding in a `RegExp`. */
function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Format an unknown thrown value as a message string. */
function formatError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
