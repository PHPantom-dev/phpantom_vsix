import * as vscode from "vscode";

// The keys under `phpantom.inlayHints` are the ones the server reads, so the
// `phpantom` section sync delivers them without any translation.
const hintSettingKeys = ["inlayHints.parameterNames", "inlayHints.closureTypes"];

/**
 * The inlay hint toggles PHPantom accepts from a client, as
 * `initializationOptions` at startup and inside the synced `phpantom`
 * section afterwards.
 *
 * The server only lets either side switch a kind off, so `true` here cannot
 * bring back a kind the project's `.phpantom.toml` disables.
 */
export interface InlayHintOptions {
    inlayHints: {
        parameterNames: boolean;
        closureTypes: boolean;
    };
}

export function registerInlayHintCommands(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand("phpantom.toggleInlayHints", toggleInlayHintsConfigs);
    context.subscriptions.push(command);
}

/**
 * Read the toggles for the server's `initializationOptions`, so the first
 * hint request after startup already honours them instead of racing the
 * initial configuration push.
 */
export function collectInlayHintOptions(folder: vscode.WorkspaceFolder | undefined): InlayHintOptions {
    const config = vscode.workspace.getConfiguration("phpantom", folder?.uri);
    return {
        inlayHints: {
            parameterNames: config.get<boolean>("inlayHints.parameterNames", true),
            closureTypes: config.get<boolean>("inlayHints.closureTypes", true)
        }
    };
}

/**
 * Flip every hint kind together. When the kinds disagree, all of them are
 * hidden, since some hints are still showing.
 */
async function toggleInlayHintsConfigs(): Promise<void> {
    const config = vscode.workspace.getConfiguration("phpantom");
    const show = !hintSettingKeys.some((key) => config.get<boolean>(key, true));

    // Sequential, because each update rewrites the same settings file.
    for (const key of hintSettingKeys) {
        await config.update(key, show, configurationTargetFor(config, key));
    }
}

/**
 * Pick where to write a setting: a workspace value overrides the user value,
 * so writing to the user settings would change nothing.
 */
function configurationTargetFor(config: vscode.WorkspaceConfiguration, key: string): vscode.ConfigurationTarget {
    return config.inspect(key)?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
}
