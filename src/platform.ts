export type PlatformKey =
    | "darwin-arm64"
    | "darwin-x64"
    | "linux-arm64"
    | "linux-x64"
    | "win32-x64"
    | "win32-arm64";

export interface PlatformInfo {
    platformKey: PlatformKey;
    targetTriple: string;
    binaryName: "phpantom_lsp" | "phpantom_lsp.exe";
    assetCandidates: string[];
}

interface PlatformMapping {
    platformKey: PlatformKey;
    targetTriple: string;
    archiveExtension: "tar.gz" | "zip";
    binaryName: "phpantom_lsp" | "phpantom_lsp.exe";
}

const mappings: Record<string, PlatformMapping> = {
    "darwin-arm64": {
        platformKey: "darwin-arm64",
        targetTriple: "aarch64-apple-darwin",
        archiveExtension: "tar.gz",
        binaryName: "phpantom_lsp"
    },
    "darwin-x64": {
        platformKey: "darwin-x64",
        targetTriple: "x86_64-apple-darwin",
        archiveExtension: "tar.gz",
        binaryName: "phpantom_lsp"
    },
    "linux-arm64": {
        platformKey: "linux-arm64",
        targetTriple: "aarch64-unknown-linux-gnu",
        archiveExtension: "tar.gz",
        binaryName: "phpantom_lsp"
    },
    "linux-x64": {
        platformKey: "linux-x64",
        targetTriple: "x86_64-unknown-linux-gnu",
        archiveExtension: "tar.gz",
        binaryName: "phpantom_lsp"
    },
    "win32-x64": {
        platformKey: "win32-x64",
        targetTriple: "x86_64-pc-windows-msvc",
        archiveExtension: "zip",
        binaryName: "phpantom_lsp.exe"
    },
    "win32-arm64": {
        platformKey: "win32-arm64",
        targetTriple: "aarch64-pc-windows-msvc",
        archiveExtension: "zip",
        binaryName: "phpantom_lsp.exe"
    }
};

export function getPlatformInfo(): PlatformInfo {
    const lookupKey = `${process.platform}-${process.arch}`;
    const mapping = mappings[lookupKey];

    if (!mapping) {
        throw new Error(
            `Unsupported platform ${lookupKey}. PHPantom publishes binaries for darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-x64, and win32-arm64. You can build phpantom_lsp from source and set phpantom.serverPath manually.`
        );
    }

    return {
        platformKey: mapping.platformKey,
        targetTriple: mapping.targetTriple,
        binaryName: mapping.binaryName,
        assetCandidates: buildAssetCandidates(mapping)
    };
}

function buildAssetCandidates(mapping: PlatformMapping): string[] {
    const secondaryArchive = mapping.archiveExtension === "zip" ? "tar.gz" : "zip";

    return [
        `phpantom_lsp-${mapping.targetTriple}.${mapping.archiveExtension}`,
        `phpantom_lsp-${mapping.targetTriple}.${secondaryArchive}`,
        `phpantom_lsp-${mapping.platformKey}.${mapping.archiveExtension}`,
        `phpantom_lsp-${mapping.platformKey}.${secondaryArchive}`,
        `phpantom_lsp-${mapping.targetTriple}.tgz`,
        `phpantom_lsp-${mapping.platformKey}.tgz`,
        `phpantom_lsp-${mapping.targetTriple}.gz`,
        `phpantom_lsp-${mapping.platformKey}.gz`,
        `phpantom_lsp-${mapping.targetTriple}`,
        `phpantom_lsp-${mapping.platformKey}`
    ];
}
