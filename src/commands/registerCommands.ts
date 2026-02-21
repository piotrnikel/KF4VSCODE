import * as vscode from 'vscode';
import { AuthService } from '../auth/authService';
import { JobRunService } from '../jobs/jobRunService';
import { KubeflowTreeProvider } from '../ui/tree/kubeflowTreeProvider';
import { getSettings } from '../utils/settings';

export function registerCommands(
  context: vscode.ExtensionContext,
  authService: AuthService,
  jobRunService: JobRunService,
  treeProvider: KubeflowTreeProvider
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kubeflow.login', async () => {
      try {
        await authService.loginInteractive();
        vscode.window.showInformationMessage('Kubeflow login successful.');
        treeProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Kubeflow login failed: ${String(e)}`);
      }
    }),
    vscode.commands.registerCommand('kubeflow.signOut', async () => {
      await authService.signOut();
      vscode.window.showInformationMessage('Kubeflow session cleared.');
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('kubeflow.runTrainingJob', () => jobRunService.runFromActivePythonFile()),
    vscode.commands.registerCommand('kubeflow.viewGeneratedYaml', async () => {
      const manifest = jobRunService.getLastManifest();
      if (!manifest) {
        vscode.window.showInformationMessage('No generated manifest yet.');
        return;
      }
      const doc = await vscode.workspace.openTextDocument({
        language: 'yaml',
        content: JSON.stringify(manifest, null, 2)
      });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('kubeflow.openDashboard', async () => {
      const url = getSettings().url;
      if (!url) return vscode.window.showWarningMessage('Configure kflow.url first.');
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('kubeflow.refreshPanel', () => treeProvider.refresh()),
    vscode.commands.registerCommand('kubeflow.restartJob', () => vscode.window.showInformationMessage('Restart Job: use Run Training Job with same parameters (v1 implementation).')),
    vscode.commands.registerCommand('kubeflow.createNotebook', () => vscode.window.showInformationMessage('Create Notebook is planned for v1.2.')),
    vscode.commands.registerCommand('kubeflow.deleteTrainingJob', () => vscode.window.showInformationMessage('Delete Training Job command scaffolded.')),
    vscode.commands.registerCommand('kubeflow.describeJob', () => vscode.window.showInformationMessage('Describe Job command scaffolded.')),
    vscode.commands.registerCommand('kubeflow.createPVC', () => vscode.window.showInformationMessage('Create PVC command scaffolded.'))
  );
}
