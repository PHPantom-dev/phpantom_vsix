import * as vscode from "vscode";

const openSeeReferenceCommand = "phpantom.openSeeReference";
const maxStoredSeeReferences = 200;
const seeReferenceTargets = new Map<string, vscode.Location>();

interface PhpDocDescription {
    markdown: string;
    candidates: string[];
    document: vscode.TextDocument;
}

interface PhpReference {
    original: string;
    className?: string;
    memberName?: string;
    functionName?: string;
}

interface NamespaceContext {
    namespaceName: string;
    imports: Map<string, string>;
}

interface FormatContext {
    sourceDocument?: vscode.TextDocument;
    token: vscode.CancellationToken;
}

export function registerHoverCommands(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
        vscode.commands.registerCommand(openSeeReferenceCommand, async (referenceId: string) => {
            const location = seeReferenceTargets.get(referenceId);
            if (!location) {
                return;
            }

            const document = await vscode.workspace.openTextDocument(location.uri);
            const editor = await vscode.window.showTextDocument(document);
            editor.selection = new vscode.Selection(location.range.start, location.range.start);
            editor.revealRange(location.range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        })
    );
}

export async function enhancePhpHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
    hover: vscode.Hover | null | undefined
): Promise<vscode.Hover | null | undefined> {
    if (!hover || document.languageId !== "php") {
        return hover;
    }

    const phpDocDescription = await getDefinitionPhpDocDescription(document, position, token);
    const formatContext: FormatContext = {
        sourceDocument: phpDocDescription?.document,
        token
    };
    const contents: Array<vscode.MarkdownString | vscode.MarkedString> = [];
    let changed = false;

    for (const content of hover.contents) {
        const enhanced = await enhanceHoverContent(content, phpDocDescription, formatContext);
        contents.push(enhanced.content);
        changed = changed || enhanced.changed;
    }

    if (!changed) {
        return hover;
    }

    return new vscode.Hover(contents, hover.range);
}

async function enhanceHoverContent(
    content: vscode.MarkdownString | vscode.MarkedString,
    phpDocDescription: PhpDocDescription | undefined,
    formatContext: FormatContext
): Promise<{ content: vscode.MarkdownString | vscode.MarkedString; changed: boolean }> {
    if (typeof content === "string") {
        const replaced = replaceFlattenedDescription(content, phpDocDescription);
        const formatted = await formatPhpDocTagsOutsideCodeBlocks(replaced, formatContext);
        const markdown = new vscode.MarkdownString(formatted.value);
        markdown.isTrusted = mergeMarkdownTrust(undefined, formatted.hasCommandLinks);

        return {
            content: formatted.value === content
                ? content
                : markdown,
            changed: formatted.value !== content
        };
    }

    if (content instanceof vscode.MarkdownString) {
        const replaced = replaceFlattenedDescription(content.value, phpDocDescription);
        const formatted = await formatPhpDocTagsOutsideCodeBlocks(replaced, formatContext);
        if (formatted.value === content.value) {
            return {
                content,
                changed: false
            };
        }

        const markdown = new vscode.MarkdownString(formatted.value, content.supportThemeIcons);
        markdown.baseUri = content.baseUri;
        markdown.supportHtml = content.supportHtml;
        markdown.isTrusted = mergeMarkdownTrust(content.isTrusted, formatted.hasCommandLinks);

        return {
            content: markdown,
            changed: true
        };
    }

    return {
        content,
        changed: false
    };
}

async function getDefinitionPhpDocDescription(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken
): Promise<PhpDocDescription | undefined> {
    if (token.isCancellationRequested) {
        return undefined;
    }

    let definitions: vscode.Definition | vscode.DefinitionLink[] | undefined;
    try {
        definitions = await vscode.commands.executeCommand<vscode.Definition | vscode.DefinitionLink[]>(
            "vscode.executeDefinitionProvider",
            document.uri,
            position
        );
    } catch {
        return undefined;
    }

    if (token.isCancellationRequested) {
        return undefined;
    }

    const definition = firstDefinition(definitions);
    if (!definition || definition.uri.scheme !== "file") {
        return undefined;
    }

    let definitionDocument: vscode.TextDocument;
    try {
        definitionDocument = definition.uri.toString() === document.uri.toString()
            ? document
            : await vscode.workspace.openTextDocument(definition.uri);
    } catch {
        return undefined;
    }

    return extractPhpDocDescription(definitionDocument, definition.range.start.line);
}

function firstDefinition(
    definitions: vscode.Definition | vscode.DefinitionLink[] | undefined
): vscode.Location | undefined {
    if (!definitions) {
        return undefined;
    }

    const entries = Array.isArray(definitions) ? definitions : [definitions];
    for (const entry of entries) {
        let location: vscode.Location;
        if ("targetUri" in entry) {
            location = new vscode.Location(entry.targetUri, entry.targetSelectionRange ?? entry.targetRange);
        } else {
            location = entry;
        }

        if (location.uri.scheme === "file") {
            return location;
        }
    }

    return undefined;
}

function extractPhpDocDescription(
    document: vscode.TextDocument,
    declarationLine: number
): PhpDocDescription | undefined {
    const block = findPhpDocBlock(document, declarationLine);
    if (!block) {
        return undefined;
    }

    const descriptionLines: string[] = [];
    for (const line of block.lines) {
        if (isPhpDocMetadataTag(line.trim())) {
            break;
        }

        descriptionLines.push(line);
    }

    const paragraphs = splitPhpDocParagraphs(descriptionLines);
    if (paragraphs.length === 0) {
        return undefined;
    }

    const paragraphTexts = paragraphs.map((paragraph) => paragraph.join(" ").trim());
    const markdown = paragraphTexts.join("\n\n");
    const candidates = uniqueStrings([
        paragraphTexts.join(""),
        paragraphTexts.join(" "),
        descriptionLines.filter((line) => line.trim().length > 0).map((line) => line.trim()).join(""),
        descriptionLines.filter((line) => line.trim().length > 0).map((line) => line.trim()).join(" ")
    ]);

    return {
        markdown,
        candidates,
        document
    };
}

function findPhpDocBlock(
    document: vscode.TextDocument,
    declarationLine: number
): { lines: string[] } | undefined {
    let endLine = declarationLine - 1;
    while (endLine >= 0 && document.lineAt(endLine).text.trim() === "") {
        endLine -= 1;
    }

    if (endLine < 0 || !document.lineAt(endLine).text.trim().endsWith("*/")) {
        return undefined;
    }

    let startLine = endLine;
    while (startLine >= 0 && !document.lineAt(startLine).text.includes("/**")) {
        startLine -= 1;
    }

    if (startLine < 0) {
        return undefined;
    }

    const lines: string[] = [];
    for (let lineNumber = startLine; lineNumber <= endLine; lineNumber += 1) {
        lines.push(cleanPhpDocLine(document.lineAt(lineNumber).text));
    }

    return {
        lines: trimBlankLines(lines)
    };
}

function cleanPhpDocLine(line: string): string {
    return line
        .replace(/^.*\/\*\*\s?/, "")
        .replace(/\s*\*\/.*$/, "")
        .replace(/^\s*\*\s?/, "")
        .trimEnd();
}

function splitPhpDocParagraphs(lines: string[]): string[][] {
    const paragraphs: string[][] = [];
    let current: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            if (current.length > 0) {
                paragraphs.push(current);
                current = [];
            }
            continue;
        }

        current.push(trimmed);
    }

    if (current.length > 0) {
        paragraphs.push(current);
    }

    return paragraphs;
}

function replaceFlattenedDescription(
    value: string,
    phpDocDescription: PhpDocDescription | undefined
): string {
    if (!phpDocDescription || phpDocDescription.markdown.length === 0) {
        return value;
    }

    for (const candidate of phpDocDescription.candidates) {
        if (candidate.length > 0 && value.startsWith(candidate)) {
            return phpDocDescription.markdown + value.slice(candidate.length);
        }

        const looseEnd = findLoosePrefixEnd(value, candidate);
        if (looseEnd !== undefined) {
            return phpDocDescription.markdown + value.slice(looseEnd);
        }
    }

    return value;
}

function isPhpDocMetadataTag(line: string): boolean {
    return /^@(api|author|covers|deprecated|extends|implements|internal|license|method|mixin|package|param|property(?:-read|-write)?|psalm-\S+|phpstan-\S+|return|since|subpackage|template|throws|todo|var|version)\b/.test(line);
}

function findLoosePrefixEnd(value: string, candidate: string): number | undefined {
    if (candidate.length === 0) {
        return undefined;
    }

    let valueIndex = 0;
    let candidateIndex = 0;

    while (valueIndex < value.length && candidateIndex < candidate.length) {
        while (/\s/.test(value[valueIndex] ?? "") && !/\s/.test(candidate[candidateIndex] ?? "")) {
            valueIndex += 1;
        }

        while (/\s/.test(candidate[candidateIndex] ?? "") && !/\s/.test(value[valueIndex] ?? "")) {
            candidateIndex += 1;
        }

        const valueCharacter = value[valueIndex];
        const candidateCharacter = candidate[candidateIndex];
        if (!valueCharacter || !candidateCharacter) {
            break;
        }

        if (/\s/.test(valueCharacter) && /\s/.test(candidateCharacter)) {
            while (/\s/.test(value[valueIndex] ?? "")) {
                valueIndex += 1;
            }

            while (/\s/.test(candidate[candidateIndex] ?? "")) {
                candidateIndex += 1;
            }

            continue;
        }

        if (valueCharacter !== candidateCharacter) {
            return undefined;
        }

        valueIndex += 1;
        candidateIndex += 1;
    }

    while (/\s/.test(candidate[candidateIndex] ?? "")) {
        candidateIndex += 1;
    }

    return candidateIndex >= candidate.length ? valueIndex : undefined;
}

async function formatPhpDocTagsOutsideCodeBlocks(
    value: string,
    formatContext: FormatContext
): Promise<{ value: string; hasCommandLinks: boolean }> {
    const parts = value.split(/(```[\s\S]*?```)/g);
    let hasCommandLinks = false;
    const formattedParts: string[] = [];

    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] ?? "";
        if (index % 2 === 1) {
            formattedParts.push(part);
            continue;
        }

        const formatted = await formatPhpDocInlineTags(part, formatContext);
        hasCommandLinks = hasCommandLinks || formatted.hasCommandLinks;
        formattedParts.push(formatted.value);
    }

    return {
        value: formattedParts.join(""),
        hasCommandLinks
    };
}

async function formatPhpDocInlineTags(
    value: string,
    formatContext: FormatContext
): Promise<{ value: string; hasCommandLinks: boolean }> {
    let hasCommandLinks = false;
    let formatted = "";
    let lastIndex = 0;
    const inlineTagPattern = /\{@(code|see)\s+([^}]+)\}/g;

    for (let match = inlineTagPattern.exec(value); match; match = inlineTagPattern.exec(value)) {
        const tagName = match[1];
        const tagValue = match[2]?.trim();
        if (!tagName || !tagValue) {
            continue;
        }

        formatted += value.slice(lastIndex, match.index);

        if (tagName === "code") {
            formatted += asInlineCode(tagValue);
        } else {
            const seeTag = await formatSeeTag(tagValue, formatContext);
            hasCommandLinks = hasCommandLinks || seeTag.hasCommandLink;
            formatted += seeTag.markdown;
        }

        lastIndex = match.index + match[0].length;
    }

    formatted += value.slice(lastIndex);

    const blockFormatted = await formatBlockSeeTags(formatted, formatContext);
    return {
        value: blockFormatted.value,
        hasCommandLinks: hasCommandLinks || blockFormatted.hasCommandLinks
    };
}

async function formatBlockSeeTags(
    value: string,
    formatContext: FormatContext
): Promise<{ value: string; hasCommandLinks: boolean }> {
    const seeLinePattern = /^(@see\s+)(\S+)(.*)$/gm;
    let hasCommandLinks = false;
    let formatted = "";
    let lastIndex = 0;

    for (let match = seeLinePattern.exec(value); match; match = seeLinePattern.exec(value)) {
        const prefix = match[1] ?? "";
        const target = match[2]?.trim();
        const suffix = match[3] ?? "";
        if (!target) {
            continue;
        }

        const seeTag = await formatSeeTag(target, formatContext);
        hasCommandLinks = hasCommandLinks || seeTag.hasCommandLink;
        formatted += value.slice(lastIndex, match.index);
        formatted += `${prefix}${seeTag.markdown}${suffix}`;
        lastIndex = match.index + match[0].length;
    }

    formatted += value.slice(lastIndex);

    return {
        value: formatted,
        hasCommandLinks
    };
}

async function formatSeeTag(
    tagValue: string,
    formatContext: FormatContext
): Promise<{ markdown: string; hasCommandLink: boolean }> {
    const [target, ...labelParts] = tagValue.split(/\s+/);
    if (!target) {
        return {
            markdown: asInlineCode(tagValue),
            hasCommandLink: false
        };
    }

    const label = labelParts.length > 0 ? labelParts.join(" ") : target;
    const url = toUrl(target);
    if (url) {
        return {
            markdown: `[${escapeMarkdownLinkText(label)}](${url})`,
            hasCommandLink: false
        };
    }

    const location = await resolvePhpReferenceLocation(target, formatContext);
    if (!location) {
        return {
            markdown: asInlineCode(label),
            hasCommandLink: false
        };
    }

    const referenceId = storeSeeReference(location);
    const args = encodeURIComponent(JSON.stringify([referenceId]));
    return {
        markdown: `[${asInlineCode(label)}](command:${openSeeReferenceCommand}?${args})`,
        hasCommandLink: true
    };
}

async function resolvePhpReferenceLocation(
    target: string,
    formatContext: FormatContext
): Promise<vscode.Location | undefined> {
    if (!formatContext.sourceDocument || formatContext.token.isCancellationRequested) {
        return undefined;
    }

    const reference = parsePhpReference(target);
    if (!reference) {
        return undefined;
    }

    const namespaceContext = parseNamespaceContext(formatContext.sourceDocument);
    const resolvedClassNames = reference.className
        ? resolveClassNames(reference.className, namespaceContext)
        : [];
    const query = reference.memberName ?? reference.functionName ?? shortName(resolvedClassNames[0] ?? reference.original);
    let symbols: vscode.SymbolInformation[] | undefined;
    try {
        symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
            "vscode.executeWorkspaceSymbolProvider",
            query
        );
    } catch {
        return undefined;
    }

    if (formatContext.token.isCancellationRequested || !Array.isArray(symbols)) {
        return undefined;
    }

    const matches = symbols.filter((symbol) => {
        return symbolMatchesReference(symbol, reference, resolvedClassNames);
    });

    if (matches.length === 1) {
        return matches[0]?.location;
    }

    const exactContainerMatch = matches.find((symbol) => {
        return resolvedClassNames.includes(symbol.containerName);
    });

    return exactContainerMatch?.location;
}

function parsePhpReference(target: string): PhpReference | undefined {
    const normalized = target
        .trim()
        .replace(/^\$/, "")
        .replace(/\(\)$/, "");

    if (normalized.length === 0) {
        return undefined;
    }

    const memberSeparator = normalized.includes("::") ? "::" : (normalized.includes("->") ? "->" : undefined);
    if (memberSeparator) {
        const [className, memberName] = normalized.split(memberSeparator, 2);
        if (!className || !memberName) {
            return undefined;
        }

        return {
            original: target,
            className,
            memberName: memberName.replace(/^\$/, "").replace(/\(\)$/, "")
        };
    }

    if (normalized.includes("\\") || /^[A-Z_]/.test(normalized)) {
        return {
            original: target,
            className: normalized
        };
    }

    return {
        original: target,
        functionName: normalized
    };
}

function parseNamespaceContext(document: vscode.TextDocument): NamespaceContext {
    const text = document.getText();
    const headerEnd = findPhpHeaderEnd(text);
    const headerText = text.slice(0, headerEnd);
    const namespaceMatch = /^\s*namespace\s+([^;{]+)[;{]/m.exec(headerText);
    const imports = new Map<string, string>();
    const usePattern = /^\s*use\s+([^;]+);/gm;

    for (let match = usePattern.exec(headerText); match; match = usePattern.exec(headerText)) {
        const statement = match[1]?.trim();
        if (!statement || /^(function|const)\s+/i.test(statement) || statement.includes("{")) {
            continue;
        }

        for (const importPart of statement.split(",")) {
            const importName = importPart.trim();
            const aliasMatch = /^(.+?)\s+as\s+([^\\\s]+)$/i.exec(importName);
            const fullyQualifiedName = aliasMatch?.[1]?.trim() ?? importName;
            const alias = aliasMatch?.[2]?.trim() ?? shortName(fullyQualifiedName);
            imports.set(alias, fullyQualifiedName.replace(/^\\/, ""));
        }
    }

    return {
        namespaceName: namespaceMatch?.[1]?.trim() ?? "",
        imports
    };
}

function findPhpHeaderEnd(text: string): number {
    const match = /^\s*(?:abstract\s+|final\s+|readonly\s+)*(class|interface|trait|enum)\s+/m.exec(text);
    return match?.index ?? text.length;
}

function resolveClassNames(className: string, namespaceContext: NamespaceContext): string[] {
    const normalized = className.replace(/^\\/, "");
    const firstSegment = normalized.split("\\")[0] ?? normalized;
    const importMatch = namespaceContext.imports.get(firstSegment);

    if (importMatch) {
        const rest = normalized.slice(firstSegment.length).replace(/^\\/, "");
        return [rest.length > 0 ? `${importMatch}\\${rest}` : importMatch];
    }

    if (className.startsWith("\\") || namespaceContext.namespaceName.length === 0) {
        return [normalized];
    }

    return uniqueStrings([
        normalized,
        `${namespaceContext.namespaceName}\\${normalized}`
    ]);
}

function symbolMatchesReference(
    symbol: vscode.SymbolInformation,
    reference: PhpReference,
    resolvedClassNames: string[]
): boolean {
    if (reference.memberName) {
        if (symbol.name !== reference.memberName && !symbol.name.endsWith(`::${reference.memberName}`)) {
            return false;
        }

        if (resolvedClassNames.length === 0) {
            return true;
        }

        return resolvedClassNames.some((resolvedClassName) => {
            const resolvedShortName = shortName(resolvedClassName);
            return symbol.name === `${resolvedShortName}::${reference.memberName}`
                || symbol.name === `${resolvedClassName}::${reference.memberName}`
                || symbol.containerName === resolvedClassName
                || symbol.containerName === resolvedShortName
                || symbol.containerName.endsWith(`\\${resolvedShortName}`);
        });
    }

    if (reference.functionName) {
        return symbol.name === reference.functionName;
    }

    if (resolvedClassNames.length === 0) {
        return false;
    }

    return resolvedClassNames.some((resolvedClassName) => {
        const normalizedSymbolName = symbol.name.replace(/^\\/, "");
        return normalizedSymbolName === resolvedClassName
            || normalizedSymbolName === shortName(resolvedClassName)
            || normalizedSymbolName.endsWith(`\\${shortName(resolvedClassName)}`);
    });
}

function storeSeeReference(location: vscode.Location): string {
    const referenceId = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    seeReferenceTargets.set(referenceId, location);

    while (seeReferenceTargets.size > maxStoredSeeReferences) {
        const oldestKey = seeReferenceTargets.keys().next().value;
        if (!oldestKey) {
            break;
        }

        seeReferenceTargets.delete(oldestKey);
    }

    return referenceId;
}

function mergeMarkdownTrust(
    current: vscode.MarkdownString["isTrusted"],
    hasCommandLinks: boolean
): vscode.MarkdownString["isTrusted"] {
    if (!hasCommandLinks || current === true) {
        return current;
    }

    if (current && typeof current === "object") {
        return {
            enabledCommands: uniqueStrings([...current.enabledCommands, openSeeReferenceCommand])
        };
    }

    return {
        enabledCommands: [openSeeReferenceCommand]
    };
}

function asInlineCode(value: string): string {
    return `\`${value.replace(/`/g, "\\`")}\``;
}

function toUrl(value: string): string | undefined {
    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    if (/^www\./i.test(value)) {
        return `https://${value}`;
    }

    return undefined;
}

function escapeMarkdownLinkText(value: string): string {
    return value.replace(/[[\]\\]/g, "\\$&");
}

function shortName(value: string): string {
    return value.split("\\").pop() ?? value;
}

function trimBlankLines(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;

    while (start < end && lines[start]?.trim() === "") {
        start += 1;
    }

    while (end > start && lines[end - 1]?.trim() === "") {
        end -= 1;
    }

    return lines.slice(start, end);
}

function uniqueStrings(values: string[]): string[] {
    return [...new Set(values.filter((value) => value.length > 0))];
}
