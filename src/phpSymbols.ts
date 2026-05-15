import * as vscode from "vscode";

type DocumentSymbolResult = vscode.SymbolInformation[] | vscode.DocumentSymbol[] | null | undefined;

interface ParsedFunction {
    symbol: vscode.DocumentSymbol;
    bodyOpen?: number;
    bodyClose?: number;
    start: number;
    parentClass?: ParsedClass;
}

interface ParsedClass {
    symbol: vscode.DocumentSymbol;
    bodyOpen: number;
    bodyClose: number;
    start: number;
}

const phpIdentifier = "[A-Za-z_\\x80-\\xff][A-Za-z0-9_\\x80-\\xff]*";
const classLikePattern = new RegExp(`\\b(class|interface|trait|enum)\\s+(${phpIdentifier})\\b`, "g");
const namedFunctionPattern = new RegExp(`\\bfunction\\s+&?\\s*(${phpIdentifier})\\s*\\(`, "g");
const anonymousClassPseudoNames = new Set(["extends", "implements", "with"]);

// Sticky Scroll uses the PHP outline model, so methods need ranges that span their bodies.
export function augmentPhpDocumentSymbols(
    document: vscode.TextDocument,
    symbols: DocumentSymbolResult
): DocumentSymbolResult {
    if (document.languageId !== "php") {
        return symbols;
    }

    const parsedSymbols = parsePhpDocumentSymbols(document);
    if (parsedSymbols.length === 0) {
        return symbols;
    }

    if (!symbols || symbols.length === 0 || !isDocumentSymbolArray(symbols)) {
        return parsedSymbols;
    }

    return mergeParsedSymbols(symbols, parsedSymbols);
}

function parsePhpDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    const text = document.getText();
    const maskedText = maskPhpNonCode(text);
    const classes = parseClassSymbols(document, maskedText);
    const functions = parseFunctionSymbols(document, maskedText, classes);
    const roots: vscode.DocumentSymbol[] = [];

    for (const parsedClass of classes) {
        roots.push(parsedClass.symbol);
    }

    for (const parsedFunction of functions) {
        if (parsedFunction.parentClass) {
            parsedFunction.parentClass.symbol.children.push(parsedFunction.symbol);
        } else {
            roots.push(parsedFunction.symbol);
        }
    }

    sortSymbols(roots);
    return roots;
}

function parseClassSymbols(document: vscode.TextDocument, maskedText: string): ParsedClass[] {
    const classes: ParsedClass[] = [];
    classLikePattern.lastIndex = 0;

    for (let match = classLikePattern.exec(maskedText); match; match = classLikePattern.exec(maskedText)) {
        const kindName = match[1];
        const name = match[2];
        if (!kindName || !name || anonymousClassPseudoNames.has(name)) {
            continue;
        }

        const declaration = findDeclarationTerminator(maskedText, match.index);
        if (declaration?.bodyOpen === undefined) {
            continue;
        }

        const bodyClose = findMatchingBrace(maskedText, declaration.bodyOpen);
        if (bodyClose === undefined) {
            continue;
        }

        const nameStart = match.index + match[0].lastIndexOf(name);
        const symbol = new vscode.DocumentSymbol(
            name,
            "",
            toClassSymbolKind(kindName),
            toRange(document, match.index, bodyClose + 1),
            toRange(document, nameStart, nameStart + name.length)
        );

        classes.push({
            symbol,
            bodyOpen: declaration.bodyOpen,
            bodyClose,
            start: match.index
        });
    }

    return classes;
}

function parseFunctionSymbols(
    document: vscode.TextDocument,
    maskedText: string,
    classes: ParsedClass[]
): ParsedFunction[] {
    const functions: ParsedFunction[] = [];
    namedFunctionPattern.lastIndex = 0;

    for (let match = namedFunctionPattern.exec(maskedText); match; match = namedFunctionPattern.exec(maskedText)) {
        const name = match[1];
        if (!name) {
            continue;
        }

        const declaration = findDeclarationTerminator(maskedText, match.index);
        if (!declaration) {
            continue;
        }

        const bodyClose = declaration.bodyOpen === undefined
            ? declaration.declarationEnd
            : findMatchingBrace(maskedText, declaration.bodyOpen);
        if (bodyClose === undefined) {
            continue;
        }

        const parentClass = findContainingClass(classes, match.index);
        const nameStart = match.index + match[0].lastIndexOf(name);
        const symbol = new vscode.DocumentSymbol(
            name,
            "",
            parentClass ? toMethodSymbolKind(name) : vscode.SymbolKind.Function,
            toRange(document, match.index, bodyClose + 1),
            toRange(document, nameStart, nameStart + name.length)
        );

        functions.push({
            symbol,
            bodyOpen: declaration.bodyOpen,
            bodyClose,
            start: match.index,
            parentClass
        });
    }

    return functions.filter((candidate) => !isNestedFunction(candidate, functions));
}

function findDeclarationTerminator(
    maskedText: string,
    start: number
): { bodyOpen?: number; declarationEnd: number } | undefined {
    let parenDepth = 0;
    let bracketDepth = 0;

    for (let index = start; index < maskedText.length; index += 1) {
        const character = maskedText[index];

        if (character === "(") {
            parenDepth += 1;
            continue;
        }

        if (character === ")") {
            parenDepth = Math.max(0, parenDepth - 1);
            continue;
        }

        if (character === "[") {
            bracketDepth += 1;
            continue;
        }

        if (character === "]") {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
        }

        if (parenDepth > 0 || bracketDepth > 0) {
            continue;
        }

        if (character === "{") {
            return {
                bodyOpen: index,
                declarationEnd: index
            };
        }

        if (character === ";") {
            return {
                declarationEnd: index
            };
        }
    }

    return undefined;
}

function findMatchingBrace(maskedText: string, openBrace: number): number | undefined {
    let depth = 0;

    for (let index = openBrace; index < maskedText.length; index += 1) {
        const character = maskedText[index];

        if (character === "{") {
            depth += 1;
            continue;
        }

        if (character === "}") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }

    return undefined;
}

function findContainingClass(classes: ParsedClass[], index: number): ParsedClass | undefined {
    const containingClasses = classes.filter((candidate) => {
        return candidate.bodyOpen < index && index < candidate.bodyClose;
    });

    containingClasses.sort((left, right) => {
        return (left.bodyClose - left.bodyOpen) - (right.bodyClose - right.bodyOpen);
    });

    return containingClasses[0];
}

function isNestedFunction(candidate: ParsedFunction, functions: ParsedFunction[]): boolean {
    return functions.some((other) => {
        if (other === candidate || other.bodyOpen === undefined || other.bodyClose === undefined) {
            return false;
        }

        return other.bodyOpen < candidate.start && candidate.start < other.bodyClose;
    });
}

function mergeParsedSymbols(
    symbols: vscode.DocumentSymbol[],
    parsedSymbols: vscode.DocumentSymbol[]
): vscode.DocumentSymbol[] {
    const merged = symbols.map(cloneDocumentSymbol);

    for (const parsedSymbol of parsedSymbols) {
        mergeParsedSymbol(merged, parsedSymbol);
    }

    sortSymbols(merged);
    return merged;
}

function mergeParsedSymbol(symbols: vscode.DocumentSymbol[], parsedSymbol: vscode.DocumentSymbol): void {
    const matchingSymbol = findEquivalentSymbol(symbols, parsedSymbol);
    if (matchingSymbol) {
        widenSymbolRange(matchingSymbol, parsedSymbol);

        for (const parsedChild of parsedSymbol.children) {
            mergeParsedSymbol(matchingSymbol.children, parsedChild);
        }

        sortSymbols(matchingSymbol.children);
        return;
    }

    const container = findBestContainer(symbols, parsedSymbol);
    const targetChildren = container ? container.children : symbols;
    targetChildren.push(cloneDocumentSymbol(parsedSymbol));
    sortSymbols(targetChildren);
}

function findEquivalentSymbol(
    symbols: vscode.DocumentSymbol[],
    parsedSymbol: vscode.DocumentSymbol
): vscode.DocumentSymbol | undefined {
    for (const symbol of symbols) {
        if (isEquivalentSymbol(symbol, parsedSymbol)) {
            return symbol;
        }

        const child = findEquivalentSymbol(symbol.children, parsedSymbol);
        if (child) {
            return child;
        }
    }

    return undefined;
}

function isEquivalentSymbol(left: vscode.DocumentSymbol, right: vscode.DocumentSymbol): boolean {
    if (left.name !== right.name || !compatibleSymbolKinds(left.kind, right.kind)) {
        return false;
    }

    return samePosition(left.selectionRange.start, right.selectionRange.start)
        || rangesOverlap(left.range, right.range);
}

function compatibleSymbolKinds(left: vscode.SymbolKind, right: vscode.SymbolKind): boolean {
    if (left === right) {
        return true;
    }

    return isFunctionLikeKind(left) && isFunctionLikeKind(right);
}

function isFunctionLikeKind(kind: vscode.SymbolKind): boolean {
    return kind === vscode.SymbolKind.Function
        || kind === vscode.SymbolKind.Method
        || kind === vscode.SymbolKind.Constructor;
}

function widenSymbolRange(symbol: vscode.DocumentSymbol, parsedSymbol: vscode.DocumentSymbol): void {
    if (symbol.range.end.isBefore(parsedSymbol.range.end)) {
        symbol.range = parsedSymbol.range;
    }
}

function findBestContainer(
    symbols: vscode.DocumentSymbol[],
    parsedSymbol: vscode.DocumentSymbol
): vscode.DocumentSymbol | undefined {
    let best: vscode.DocumentSymbol | undefined;

    for (const symbol of symbols) {
        if (!canContainSymbols(symbol) || !containsRange(symbol.range, parsedSymbol.range)) {
            continue;
        }

        const childContainer = findBestContainer(symbol.children, parsedSymbol);
        best = childContainer ?? symbol;
    }

    return best;
}

function canContainSymbols(symbol: vscode.DocumentSymbol): boolean {
    return symbol.kind === vscode.SymbolKind.Namespace
        || symbol.kind === vscode.SymbolKind.Module
        || symbol.kind === vscode.SymbolKind.Package
        || symbol.kind === vscode.SymbolKind.Class
        || symbol.kind === vscode.SymbolKind.Interface
        || symbol.kind === vscode.SymbolKind.Enum
        || symbol.kind === vscode.SymbolKind.Struct;
}

function cloneDocumentSymbol(symbol: vscode.DocumentSymbol): vscode.DocumentSymbol {
    const clone = new vscode.DocumentSymbol(
        symbol.name,
        symbol.detail,
        symbol.kind,
        symbol.range,
        symbol.selectionRange
    );
    clone.tags = symbol.tags;
    clone.children = symbol.children.map(cloneDocumentSymbol);

    return clone;
}

function isDocumentSymbolArray(symbols: vscode.SymbolInformation[] | vscode.DocumentSymbol[]): symbols is vscode.DocumentSymbol[] {
    return symbols.every((symbol) => {
        return "selectionRange" in symbol && "children" in symbol;
    });
}

function sortSymbols(symbols: vscode.DocumentSymbol[]): void {
    symbols.sort((left, right) => {
        if (left.range.start.line !== right.range.start.line) {
            return left.range.start.line - right.range.start.line;
        }

        return left.range.start.character - right.range.start.character;
    });

    for (const symbol of symbols) {
        sortSymbols(symbol.children);
    }
}

function toClassSymbolKind(kindName: string): vscode.SymbolKind {
    switch (kindName) {
        case "interface":
            return vscode.SymbolKind.Interface;
        case "enum":
            return vscode.SymbolKind.Enum;
        default:
            return vscode.SymbolKind.Class;
    }
}

function toMethodSymbolKind(name: string): vscode.SymbolKind {
    return name.toLowerCase() === "__construct"
        ? vscode.SymbolKind.Constructor
        : vscode.SymbolKind.Method;
}

function toRange(document: vscode.TextDocument, start: number, end: number): vscode.Range {
    return new vscode.Range(document.positionAt(start), document.positionAt(Math.min(end, document.getText().length)));
}

function samePosition(left: vscode.Position, right: vscode.Position): boolean {
    return left.line === right.line && left.character === right.character;
}

function rangesOverlap(left: vscode.Range, right: vscode.Range): boolean {
    return left.start.isBeforeOrEqual(right.end) && right.start.isBeforeOrEqual(left.end);
}

function containsRange(outer: vscode.Range, inner: vscode.Range): boolean {
    return outer.start.isBeforeOrEqual(inner.start) && inner.end.isBeforeOrEqual(outer.end);
}

function maskPhpNonCode(text: string): string {
    const characters = text.split("");
    let index = 0;

    while (index < text.length) {
        const character = text[index];
        const nextCharacter = text[index + 1];

        if (character === "/" && nextCharacter === "/") {
            index = maskLineComment(characters, index);
            continue;
        }

        if (character === "#" && nextCharacter !== "[") {
            index = maskLineComment(characters, index);
            continue;
        }

        if (character === "/" && nextCharacter === "*") {
            index = maskBlockComment(characters, text, index);
            continue;
        }

        if (character === "'" || character === "\"") {
            index = maskQuotedString(characters, text, index, character);
            continue;
        }

        if (character === "<" && text.startsWith("<<<", index)) {
            const heredocEnd = maskHeredoc(characters, text, index);
            if (heredocEnd !== undefined) {
                index = heredocEnd;
                continue;
            }
        }

        index += 1;
    }

    return characters.join("");
}

function maskLineComment(characters: string[], start: number): number {
    let index = start;

    while (index < characters.length && characters[index] !== "\n" && characters[index] !== "\r") {
        characters[index] = " ";
        index += 1;
    }

    return index;
}

function maskBlockComment(characters: string[], text: string, start: number): number {
    let index = start + 2;

    while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) {
        index += 1;
    }

    const end = index < text.length ? index + 2 : text.length;
    maskRange(characters, start, end);

    return end;
}

function maskQuotedString(characters: string[], text: string, start: number, quote: string): number {
    let index = start + 1;

    while (index < text.length) {
        if (text[index] === "\\") {
            index += 2;
            continue;
        }

        if (text[index] === quote) {
            index += 1;
            break;
        }

        index += 1;
    }

    maskRange(characters, start, index);
    return index;
}

function maskHeredoc(characters: string[], text: string, start: number): number | undefined {
    const lineEnd = findLineEnd(text, start);
    const header = text.slice(start, lineEnd);
    const match = /^<<<\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/.exec(header);
    const marker = match?.[1] ?? match?.[2] ?? match?.[3];
    if (!marker) {
        return undefined;
    }

    let index = nextLineStart(text, lineEnd);
    while (index < text.length) {
        const currentLineEnd = findLineEnd(text, index);
        const line = text.slice(index, currentLineEnd);

        if (new RegExp(`^[ \\t]*${escapeRegExp(marker)}\\b\\s*;?\\s*$`).test(line)) {
            maskRange(characters, start, currentLineEnd);
            return currentLineEnd;
        }

        index = nextLineStart(text, currentLineEnd);
    }

    maskRange(characters, start, text.length);
    return text.length;
}

function maskRange(characters: string[], start: number, end: number): void {
    for (let index = start; index < end; index += 1) {
        if (characters[index] !== "\n" && characters[index] !== "\r") {
            characters[index] = " ";
        }
    }
}

function findLineEnd(text: string, start: number): number {
    let index = start;

    while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
        index += 1;
    }

    return index;
}

function nextLineStart(text: string, lineEnd: number): number {
    if (text[lineEnd] === "\r" && text[lineEnd + 1] === "\n") {
        return lineEnd + 2;
    }

    if (text[lineEnd] === "\r" || text[lineEnd] === "\n") {
        return lineEnd + 1;
    }

    return lineEnd;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
