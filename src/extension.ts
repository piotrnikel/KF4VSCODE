import * as vscode from 'vscode';
import { AuthService } from './auth/authService';
import { ArtifactPackager } from './artifacts/artifactPackager';
import { registerCommands } from './commands/registerCommands';
import { JobRunService } from './jobs/jobRunService';
import { K8sApiClient } from './kube/k8sApiClient';
import { ManifestBuilder } from './manifest/manifestBuilder';
import { KubeflowTreeProvider } from './ui/tree/kubeflowTreeProvider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const authService = new AuthService(context.secrets);
  await authService.initialize();

  const k8sClient = new K8sApiClient(authService);
  const jobRunService = new JobRunService(k8sClient, new ArtifactPackager(), new ManifestBuilder());
  const treeProvider = new KubeflowTreeProvider(k8sClient);

  vscode.window.registerTreeDataProvider('kubeflowPanel', treeProvider);
  registerCommands(context, authService, jobRunService, treeProvider);

  context.subscriptions.push(authService);
}

export function deactivate(): void {
  // no-op
}
