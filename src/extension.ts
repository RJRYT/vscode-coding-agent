import * as vscode from 'vscode';
import { NemotronAgentView } from './view';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new NemotronAgentView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('nemotronAgent.chatView', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('nemotronAgent.setApiKey', async () => {
      const value = await vscode.window.showInputBox({
        title: 'NVIDIA API Key',
        prompt: 'Paste your NVIDIA NIM API key. It will be stored in VS Code Secret Storage.',
        password: true,
        ignoreFocusOut: true,
      });
      if (value?.trim()) {
        await context.secrets.store('nemotronAgent.nvidiaApiKey', value.trim());
        void vscode.window.showInformationMessage('NVIDIA API key saved securely.');
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('nemotronAgent.clearApiKey', async () => {
      await context.secrets.delete('nemotronAgent.nvidiaApiKey');
      void vscode.window.showInformationMessage('NVIDIA API key removed.');
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('nemotronAgent.newChat', () => {
      provider.resetConversation();
      void vscode.commands.executeCommand('workbench.view.extension.nemotronAgent');
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('nemotronAgent.focus', () =>
      vscode.commands.executeCommand('workbench.view.extension.nemotronAgent')
    )
  );
}

export function deactivate(): void {}
