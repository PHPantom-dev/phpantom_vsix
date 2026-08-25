import * as vscode from "vscode";
import {
    ClientCapabilities,
    DynamicFeature,
    ExecuteCommandRegistrationOptions,
    ExecuteCommandRequest,
    FeatureState,
    LanguageClient,
    LSPAny,
    RegistrationData,
    RegistrationType,
    ServerCapabilities
} from "vscode-languageclient/node";

/**
 * Server-advertised commands, shared across every running language server.
 *
 * VS Code commands live in a single process-wide namespace, but PHPantom runs
 * one server per workspace folder. The stock execute-command feature registers
 * each command the server advertises unconditionally, so the second folder's
 * server aborts initialization with "command ... already exists" and that
 * folder ends up with no language support at all.
 *
 * `SharedExecuteCommandFeature` replaces it: a command is registered with VS
 * Code once, and invoking it is forwarded to the server that owns the active
 * editor.
 */

interface CommandOwner {
    client: LanguageClient;
}

interface SharedCommand {
    disposable: vscode.Disposable;
    owners: CommandOwner[];
}

const sharedCommands = new Map<string, SharedCommand>();

let nextRegistrationId = 1;

export class SharedExecuteCommandFeature implements DynamicFeature<ExecuteCommandRegistrationOptions> {
    private readonly registrations = new Map<string, string[]>();

    constructor(private readonly client: LanguageClient) {}

    get registrationType(): RegistrationType<ExecuteCommandRegistrationOptions> {
        return ExecuteCommandRequest.type;
    }

    getState(): FeatureState {
        return {
            kind: "workspace",
            id: this.registrationType.method,
            registrations: this.registrations.size > 0
        };
    }

    fillClientCapabilities(capabilities: ClientCapabilities): void {
        if (!capabilities.workspace) {
            capabilities.workspace = {};
        }
        if (!capabilities.workspace.executeCommand) {
            capabilities.workspace.executeCommand = {};
        }
        capabilities.workspace.executeCommand.dynamicRegistration = true;
    }

    initialize(capabilities: ServerCapabilities): void {
        if (!capabilities.executeCommandProvider) {
            return;
        }

        this.register({
            id: `phpantom-execute-command-${nextRegistrationId++}`,
            registerOptions: { ...capabilities.executeCommandProvider }
        });
    }

    register(data: RegistrationData<ExecuteCommandRegistrationOptions>): void {
        const commands = data.registerOptions.commands ?? [];
        for (const command of commands) {
            claimCommand(command, this.client);
        }
        this.registrations.set(data.id, [...commands]);
    }

    unregister(id: string): void {
        const commands = this.registrations.get(id);
        if (!commands) {
            return;
        }

        this.registrations.delete(id);
        for (const command of commands) {
            releaseCommand(command, this.client);
        }
    }

    clear(): void {
        for (const id of [...this.registrations.keys()]) {
            this.unregister(id);
        }
    }
}

function claimCommand(command: string, client: LanguageClient): void {
    const existing = sharedCommands.get(command);
    if (existing) {
        if (!existing.owners.some((owner) => owner.client === client)) {
            existing.owners.push({ client });
        }
        return;
    }

    const owners: CommandOwner[] = [{ client }];
    const disposable = vscode.commands.registerCommand(command, (...args: LSPAny[]) =>
        executeCommand(command, owners, args)
    );
    sharedCommands.set(command, { disposable, owners });
}

function releaseCommand(command: string, client: LanguageClient): void {
    const shared = sharedCommands.get(command);
    if (!shared) {
        return;
    }

    const index = shared.owners.findIndex((owner) => owner.client === client);
    if (index !== -1) {
        shared.owners.splice(index, 1);
    }

    if (shared.owners.length === 0) {
        shared.disposable.dispose();
        sharedCommands.delete(command);
    }
}

function executeCommand(command: string, owners: CommandOwner[], args: LSPAny[]): vscode.ProviderResult<LSPAny> {
    const owner = pickOwner(owners);
    if (!owner) {
        return undefined;
    }

    const client = owner.client;
    const send = (name: string, sendArgs: LSPAny[]): Promise<LSPAny> =>
        client
            .sendRequest(ExecuteCommandRequest.type, { command: name, arguments: sendArgs })
            .then(undefined, (error) =>
                client.handleFailedRequest(ExecuteCommandRequest.type, undefined, error, undefined)
            );

    const middleware = client.clientOptions.middleware?.executeCommand;
    return middleware ? middleware(command, args, send) : send(command, args);
}

/**
 * Pick the server a command invocation belongs to: the one whose folder holds
 * the active editor, falling back to the server that registered the command
 * first when nothing matches (a command run from a menu or another view).
 */
function pickOwner(owners: CommandOwner[]): CommandOwner | undefined {
    if (owners.length <= 1) {
        return owners[0];
    }

    const document = vscode.window.activeTextEditor?.document;
    if (document) {
        const match = owners.find((owner) => ownsDocument(owner, document));
        if (match) {
            return match;
        }
    }

    return owners[0];
}

function ownsDocument(owner: CommandOwner, document: vscode.TextDocument): boolean {
    const folder = owner.client.clientOptions.workspaceFolder;
    if (!folder) {
        return document.uri.scheme === "untitled";
    }

    const folderUri = folder.uri.toString();
    const prefix = folderUri.endsWith("/") ? folderUri : `${folderUri}/`;
    return document.uri.toString().startsWith(prefix);
}
