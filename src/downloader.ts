import * as crypto from "crypto";
import * as fs from "fs/promises";
import { constants, createReadStream, createWriteStream } from "fs";
import * as https from "https";
import * as path from "path";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import * as zlib from "zlib";
import AdmZip from "adm-zip";
import * as tar from "tar";
import * as vscode from "vscode";
import { getPlatformInfo, PlatformInfo } from "./platform";

const repository = "PHPantom-dev/phpantom_lsp";
const apiBaseUrl = `https://api.github.com/repos/${repository}/releases`;
const userAgent = "phpantom-vscode-extension";
const latestMarkerFile = "latest.json";

export interface GitHubReleaseAsset {
    name: string;
    browser_download_url: string;
    size?: number;
    digest?: string;
}

export interface GitHubRelease {
    tag_name: string;
    name?: string | null;
    prerelease?: boolean;
    assets: GitHubReleaseAsset[];
}

interface LatestMarker {
    tagName: string;
}

export interface ServerUpdateResult {
    status: "updated" | "current" | "skipped";
    releaseTag?: string;
    serverPath?: string;
    reason?: string;
}

export interface ServerUpdateOptions {
    manual?: boolean;
}

export async function resolveServerBinary(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel
): Promise<string> {
    const config = vscode.workspace.getConfiguration("phpantom");
    const configuredServerPath = config.get<string>("serverPath", "").trim();

    if (configuredServerPath) {
        const expandedPath = expandHome(configuredServerPath);
        if (await isFile(expandedPath)) {
            return expandedPath;
        }

        throw new Error(
            `PHPantom could not find the configured phpantom.serverPath: ${configuredServerPath}. Update phpantom.serverPath to an existing phpantom_lsp binary, clear the setting to use PATH or auto-download, or build phpantom_lsp from source.`
        );
    }

    const platformInfo = getPlatformInfo();
    const pathBinary = await findOnPath(platformInfo.binaryName);

    if (pathBinary) {
        return pathBinary;
    }

    const releaseTag = getReleaseTag();
    const cachedBinary = await findCachedBinary(context, platformInfo, releaseTag, outputChannel);

    if (cachedBinary) {
        return cachedBinary;
    }

    if (config.get<boolean>("autoDownload", true)) {
        return downloadServer(context, outputChannel);
    }

    throw new Error(
        "PHPantom could not find phpantom_lsp. Install phpantom_lsp on PATH, set phpantom.serverPath to a local binary, or enable phpantom.autoDownload so the extension can download it from GitHub Releases."
    );
}

export async function downloadServer(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    force = false
): Promise<string> {
    const platformInfo = getPlatformInfo();
    const requestedReleaseTag = getReleaseTag();
    const release = requestedReleaseTag === "latest"
        ? await getLatestRelease()
        : await getReleaseByTag(requestedReleaseTag);
    const releaseTag = release.tag_name;
    const destinationDir = getPlatformCacheDir(context, releaseTag, platformInfo.platformKey);
    const destinationBinary = path.join(destinationDir, platformInfo.binaryName);

    if (!force && await isFile(destinationBinary)) {
        outputChannel.appendLine(`Using cached phpantom_lsp for ${releaseTag}: ${destinationBinary}`);
        return destinationBinary;
    }

    const asset = selectAsset(release, platformInfo);

    const downloadedBinary = await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: "Downloading PHPantom language server",
            cancellable: false
        },
        async () => {
            outputChannel.appendLine(
                `Downloading ${asset.name} from ${releaseTag} for ${platformInfo.platformKey}.`
            );

            await fs.mkdir(destinationDir, { recursive: true });
            const workDir = path.join(destinationDir, ".download");
            const extractionDir = path.join(workDir, "extracted");

            await fs.rm(workDir, { recursive: true, force: true });
            await fs.mkdir(workDir, { recursive: true });

            const assetPath = path.join(workDir, asset.name);
            try {
                await downloadAsset(asset.browser_download_url, assetPath);
                await verifyDownloadedArtifact(asset, assetPath, outputChannel);

                const extractedBinary = await extractAsset(assetPath, extractionDir, platformInfo.binaryName);
                await fs.copyFile(extractedBinary, destinationBinary);
                await chmodExecutable(destinationBinary);

                outputChannel.appendLine(`Downloaded phpantom_lsp to ${destinationBinary}`);
                return destinationBinary;
            } finally {
                await fs.rm(workDir, { recursive: true, force: true });
            }
        }
    );

    if (requestedReleaseTag === "latest") {
        await writeLatestMarker(context, releaseTag);
    }

    return downloadedBinary;
}

export async function checkForServerUpdate(
    context: vscode.ExtensionContext,
    outputChannel: vscode.OutputChannel,
    options: ServerUpdateOptions = {}
): Promise<ServerUpdateResult> {
    const config = vscode.workspace.getConfiguration("phpantom");
    const configuredServerPath = config.get<string>("serverPath", "").trim();

    if (configuredServerPath) {
        return {
            status: "skipped",
            reason: "phpantom.serverPath is configured"
        };
    }

    if (!options.manual && !config.get<boolean>("autoDownload", true)) {
        return {
            status: "skipped",
            reason: "phpantom.autoDownload is disabled"
        };
    }

    if (!options.manual && !config.get<boolean>("autoUpdate", true)) {
        return {
            status: "skipped",
            reason: "phpantom.autoUpdate is disabled"
        };
    }

    const requestedReleaseTag = getReleaseTag();
    if (requestedReleaseTag !== "latest") {
        return {
            status: "skipped",
            reason: `phpantom.releaseTag is pinned to ${requestedReleaseTag}`
        };
    }

    const platformInfo = getPlatformInfo();
    const pathBinary = await findOnPath(platformInfo.binaryName);
    if (pathBinary) {
        return {
            status: "skipped",
            reason: `phpantom_lsp on PATH has priority: ${pathBinary}`
        };
    }

    outputChannel.appendLine("Checking for a newer PHPantom language server release.");
    const release = await getLatestRelease();
    const releaseTag = release.tag_name;
    await writeLatestMarker(context, releaseTag);

    const cachedBinary = getCachedBinaryPath(context, releaseTag, platformInfo);
    if (await isFile(cachedBinary)) {
        outputChannel.appendLine(`Latest PHPantom language server is already cached: ${releaseTag}`);
        return {
            status: "current",
            releaseTag,
            serverPath: cachedBinary
        };
    }

    outputChannel.appendLine(`PHPantom language server ${releaseTag} is available; downloading update.`);
    const serverPath = await downloadServer(context, outputChannel);

    return {
        status: "updated",
        releaseTag,
        serverPath
    };
}

export async function clearDownloadedServer(context: vscode.ExtensionContext): Promise<void> {
    await fs.rm(getBinCacheRoot(context), { recursive: true, force: true });
}

export async function findOnPath(binaryName: string): Promise<string | undefined> {
    const pathValue = process.env.PATH ?? process.env.Path ?? "";
    const directories = pathValue.split(path.delimiter).filter(Boolean);

    for (const directory of directories) {
        const candidate = path.join(directory, binaryName);

        if (await isExecutableFile(candidate)) {
            return candidate;
        }
    }

    return undefined;
}

export async function getLatestRelease(): Promise<GitHubRelease> {
    return fetchJson<GitHubRelease>(`${apiBaseUrl}/latest`);
}

export async function getReleaseByTag(tag: string): Promise<GitHubRelease> {
    return fetchJson<GitHubRelease>(`${apiBaseUrl}/tags/${encodeURIComponent(tag)}`);
}

export async function downloadAsset(url: string, destination: string): Promise<void> {
    await fs.mkdir(path.dirname(destination), { recursive: true });

    if (typeof fetch === "function") {
        const response = await fetch(url, {
            headers: {
                "User-Agent": userAgent,
                "Accept": "application/octet-stream"
            },
            redirect: "follow"
        });

        if (!response.ok || !response.body) {
            throw new Error(`Download failed with HTTP ${response.status} ${response.statusText}`);
        }

        await pipeline(Readable.fromWeb(response.body), createWriteStream(destination));
        return;
    }

    await downloadWithHttps(url, destination);
}

export async function extractAsset(
    assetPath: string,
    destinationDir: string,
    binaryName: string
): Promise<string> {
    await fs.rm(destinationDir, { recursive: true, force: true });
    await fs.mkdir(destinationDir, { recursive: true });

    const lowerAssetPath = assetPath.toLowerCase();

    if (lowerAssetPath.endsWith(".zip")) {
        await extractZip(assetPath, destinationDir);
    } else if (lowerAssetPath.endsWith(".tar.gz") || lowerAssetPath.endsWith(".tgz")) {
        await tar.x({
            file: assetPath,
            cwd: destinationDir,
            preservePaths: false
        });
    } else if (lowerAssetPath.endsWith(".gz")) {
        const basename = path.basename(assetPath, ".gz");
        await pipeline(
            createReadStream(assetPath),
            zlib.createGunzip(),
            createWriteStream(path.join(destinationDir, basename))
        );
    } else {
        await fs.copyFile(assetPath, path.join(destinationDir, path.basename(assetPath)));
    }

    const binaryPath = await findExtractedBinary(destinationDir, binaryName);

    if (!binaryPath) {
        throw new Error(
            `Downloaded PHPantom asset did not contain ${binaryName}. Set phpantom.serverPath to a manually extracted binary, or report the release asset layout to ${repository}.`
        );
    }

    return binaryPath;
}

export async function chmodExecutable(file: string): Promise<void> {
    if (process.platform === "win32") {
        return;
    }

    await fs.chmod(file, 0o755);
}

async function findCachedBinary(
    context: vscode.ExtensionContext,
    platformInfo: PlatformInfo,
    requestedReleaseTag: string,
    outputChannel: vscode.OutputChannel
): Promise<string | undefined> {
    if (requestedReleaseTag !== "latest") {
        const configuredCachePath = getCachedBinaryPath(context, requestedReleaseTag, platformInfo);
        return await isFile(configuredCachePath) ? configuredCachePath : undefined;
    }

    try {
        const release = await getLatestRelease();
        await writeLatestMarker(context, release.tag_name);

        const latestCachePath = getCachedBinaryPath(context, release.tag_name, platformInfo);
        return await isFile(latestCachePath) ? latestCachePath : undefined;
    } catch (error) {
        outputChannel.appendLine(
            `Could not resolve latest PHPantom release from GitHub: ${formatError(error)}`
        );

        const marker = await readLatestMarker(context);
        if (!marker) {
            return undefined;
        }

        const cachedPath = getCachedBinaryPath(context, marker.tagName, platformInfo);
        if (await isFile(cachedPath)) {
            outputChannel.appendLine(
                `Using cached PHPantom release ${marker.tagName} because GitHub latest lookup failed.`
            );
            return cachedPath;
        }

        return undefined;
    }
}

function selectAsset(release: GitHubRelease, platformInfo: PlatformInfo): GitHubReleaseAsset {
    const exactNames = new Set(platformInfo.assetCandidates);
    const exactAsset = release.assets.find((asset) => exactNames.has(asset.name));

    if (exactAsset) {
        return exactAsset;
    }

    const fuzzyAsset = release.assets.find((asset) => {
        const name = asset.name.toLowerCase();
        const containsPlatform = name.includes(platformInfo.targetTriple)
            || name.includes(platformInfo.platformKey);

        return containsPlatform && looksLikeSupportedAsset(name);
    });

    if (fuzzyAsset) {
        return fuzzyAsset;
    }

    const availableAssets = release.assets.map((asset) => asset.name).join(", ") || "(none)";
    throw new Error(
        `PHPantom could not find a download asset for ${platformInfo.platformKey} in release ${release.tag_name}. Expected one of: ${platformInfo.assetCandidates.join(", ")}. Available assets: ${availableAssets}. You can set phpantom.serverPath manually.`
    );
}

function looksLikeSupportedAsset(name: string): boolean {
    if (!name.includes("phpantom")) {
        return false;
    }

    if (name.endsWith(".sha256") || name.endsWith(".sig") || name.endsWith(".asc")) {
        return false;
    }

    return name.endsWith(".zip")
        || name.endsWith(".tar.gz")
        || name.endsWith(".tgz")
        || name.endsWith(".gz")
        || path.extname(name) === "";
}

async function fetchJson<T>(url: string): Promise<T> {
    if (typeof fetch === "function") {
        const response = await fetch(url, {
            headers: {
                "User-Agent": userAgent,
                "Accept": "application/vnd.github+json"
            },
            redirect: "follow"
        });

        if (!response.ok) {
            throw new Error(`GitHub API request failed with HTTP ${response.status} ${response.statusText}`);
        }

        return await response.json() as T;
    }

    const body = await requestTextWithHttps(url, {
        "User-Agent": userAgent,
        "Accept": "application/vnd.github+json"
    });

    return JSON.parse(body) as T;
}

async function verifyDownloadedArtifact(
    asset: GitHubReleaseAsset,
    assetPath: string,
    outputChannel: vscode.OutputChannel
): Promise<void> {
    const stat = await fs.stat(assetPath);

    if (typeof asset.size === "number" && asset.size > 0 && stat.size !== asset.size) {
        throw new Error(
            `Downloaded ${asset.name} was ${stat.size} bytes, but GitHub reported ${asset.size} bytes. Delete the cached download and try again.`
        );
    }

    if (asset.digest?.startsWith("sha256:")) {
        const expected = asset.digest.slice("sha256:".length).toLowerCase();
        const actual = await sha256File(assetPath);

        if (actual !== expected) {
            throw new Error(
                `Downloaded ${asset.name} failed SHA-256 verification. Delete the cached download and try again.`
            );
        }

        outputChannel.appendLine(`Verified ${asset.name} with GitHub SHA-256 digest.`);
        return;
    }

    outputChannel.appendLine(`Verified ${asset.name} size (${stat.size} bytes). No checksum digest was published.`);
}

async function sha256File(file: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    await pipeline(createReadStream(file), hash);
    return hash.digest("hex");
}

async function extractZip(assetPath: string, destinationDir: string): Promise<void> {
    const zip = new AdmZip(assetPath);

    for (const entry of zip.getEntries()) {
        if (entry.isDirectory) {
            continue;
        }

        const destination = safeJoin(destinationDir, entry.entryName);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.writeFile(destination, entry.getData());
    }
}

async function findExtractedBinary(
    directory: string,
    binaryName: string
): Promise<string | undefined> {
    const exactMatches: string[] = [];
    const fallbackMatches: string[] = [];

    await walk(directory, async (file) => {
        const basename = path.basename(file);

        if (basename === binaryName) {
            exactMatches.push(file);
            return;
        }

        const lowerBasename = basename.toLowerCase();
        if (
            lowerBasename.includes("phpantom")
            && !lowerBasename.endsWith(".zip")
            && !lowerBasename.endsWith(".tar.gz")
            && !lowerBasename.endsWith(".tgz")
            && !lowerBasename.endsWith(".gz")
            && !lowerBasename.endsWith(".sha256")
        ) {
            fallbackMatches.push(file);
        }
    });

    return exactMatches[0] ?? fallbackMatches[0];
}

async function walk(directory: string, onFile: (file: string) => Promise<void>): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
        const entryPath = path.join(directory, entry.name);

        if (entry.isDirectory()) {
            await walk(entryPath, onFile);
            continue;
        }

        if (entry.isFile()) {
            await onFile(entryPath);
        }
    }
}

function safeJoin(root: string, entryName: string): string {
    const normalizedEntryName = entryName.replace(/\\/g, "/");
    const destination = path.resolve(root, normalizedEntryName);
    const resolvedRoot = path.resolve(root);

    if (destination !== resolvedRoot && !destination.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error(`Refusing to extract unsafe archive entry: ${entryName}`);
    }

    return destination;
}

async function downloadWithHttps(url: string, destination: string, redirects = 0): Promise<void> {
    if (redirects > 10) {
        throw new Error("Too many redirects while downloading PHPantom language server.");
    }

    await new Promise<void>((resolve, reject) => {
        const request = https.get(
            url,
            {
                headers: {
                    "User-Agent": userAgent,
                    "Accept": "application/octet-stream"
                }
            },
            (response) => {
                const statusCode = response.statusCode ?? 0;
                const location = response.headers.location;

                if (statusCode >= 300 && statusCode < 400 && location) {
                    response.resume();
                    const redirectUrl = new URL(location, url).toString();
                    downloadWithHttps(redirectUrl, destination, redirects + 1).then(resolve, reject);
                    return;
                }

                if (statusCode < 200 || statusCode >= 300) {
                    response.resume();
                    reject(new Error(`Download failed with HTTP ${statusCode}`));
                    return;
                }

                pipeline(response, createWriteStream(destination)).then(resolve, reject);
            }
        );

        request.on("error", reject);
    });
}

async function requestTextWithHttps(
    url: string,
    headers: Record<string, string>,
    redirects = 0
): Promise<string> {
    if (redirects > 10) {
        throw new Error("Too many redirects while requesting GitHub API.");
    }

    return await new Promise<string>((resolve, reject) => {
        const request = https.get(url, { headers }, (response) => {
            const statusCode = response.statusCode ?? 0;
            const location = response.headers.location;

            if (statusCode >= 300 && statusCode < 400 && location) {
                response.resume();
                const redirectUrl = new URL(location, url).toString();
                requestTextWithHttps(redirectUrl, headers, redirects + 1).then(resolve, reject);
                return;
            }

            if (statusCode < 200 || statusCode >= 300) {
                response.resume();
                reject(new Error(`GitHub API request failed with HTTP ${statusCode}`));
                return;
            }

            const chunks: Buffer[] = [];
            response.on("data", (chunk: Buffer) => chunks.push(chunk));
            response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
            response.on("error", reject);
        });

        request.on("error", reject);
    });
}

async function isFile(file: string): Promise<boolean> {
    try {
        const stat = await fs.stat(file);
        return stat.isFile();
    } catch {
        return false;
    }
}

async function isExecutableFile(file: string): Promise<boolean> {
    if (!await isFile(file)) {
        return false;
    }

    if (process.platform === "win32") {
        return true;
    }

    try {
        await fs.access(file, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

function getReleaseTag(): string {
    const configured = vscode.workspace.getConfiguration("phpantom").get<string>("releaseTag", "latest").trim();
    return configured || "latest";
}

function getCachedBinaryPath(
    context: vscode.ExtensionContext,
    releaseTag: string,
    platformInfo: PlatformInfo
): string {
    return path.join(
        getPlatformCacheDir(context, releaseTag, platformInfo.platformKey),
        platformInfo.binaryName
    );
}

function getPlatformCacheDir(
    context: vscode.ExtensionContext,
    releaseTag: string,
    platformKey: string
): string {
    return path.join(getBinCacheRoot(context), releaseTag, platformKey);
}

function getBinCacheRoot(context: vscode.ExtensionContext): string {
    return path.join(context.globalStorageUri.fsPath, "bin");
}

async function writeLatestMarker(context: vscode.ExtensionContext, tagName: string): Promise<void> {
    const markerPath = path.join(getBinCacheRoot(context), latestMarkerFile);
    await fs.mkdir(path.dirname(markerPath), { recursive: true });
    await fs.writeFile(markerPath, JSON.stringify({ tagName } satisfies LatestMarker, undefined, 4));
}

async function readLatestMarker(context: vscode.ExtensionContext): Promise<LatestMarker | undefined> {
    try {
        const markerPath = path.join(getBinCacheRoot(context), latestMarkerFile);
        const marker = JSON.parse(await fs.readFile(markerPath, "utf8")) as LatestMarker;
        return typeof marker.tagName === "string" && marker.tagName ? marker : undefined;
    } catch {
        return undefined;
    }
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
    return error instanceof Error ? error.message : String(error);
}
