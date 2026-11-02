import * as vscode from "vscode";

// Each setting under `phpantom.inlayHints` shows or hides one kind of hint
// the server sends. The server only sends Type hints for closure parameters
// and return types, hence the setting name.
const hintKindSettings = [
    { kind: vscode.InlayHintKind.Parameter, key: "inlayHints.parameterNames" },
    { kind: vscode.InlayHintKind.Type, key: "inlayHints.closureTypes" }
];

export function registerInlayHintCommands(context: vscode.ExtensionContext): void {
    const command = vscode.commands.registerCommand("phpantom.toggleInlayHints", toggleInlayHintsConfigs);
    context.subscriptions.push(command);
}

/**
 * Drop the hints whose kind the user has switched off.
 */
export function filterInlayHints(hints: vscode.InlayHint[] | null | undefined): vscode.InlayHint[] | null | undefined {
    const config = vscode.workspace.getConfiguration("phpantom");
    const hiddenKinds = hintKindSettings.filter(({ key }) => !config.get<boolean>(key, true));

    return hints?.filter((hint) => !hiddenKinds.some(({ kind }) => kind === hint.kind));
}

/**
 * Flip every hint kind together. When the kinds disagree, all of them are
 * hidden, since some hints are still showing.
 */
async function toggleInlayHintsConfigs(): Promise<void> {
    const config = vscode.workspace.getConfiguration("phpantom");
    const show = !hintKindSettings.some(({ key }) => config.get<boolean>(key, true));

    // Sequential, because each update rewrites the same settings file.
    for (const { key } of hintKindSettings) {
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
