import * as vscode from 'vscode';
import { ArtifactPackager } from '../artifacts/artifactPackager';
import { K8sApiClient } from '../kube/k8sApiClient';
import { ManifestBuilder, JobOptions } from '../manifest/manifestBuilder';
import { getSettings } from '../utils/settings';

export class JobRunService {
  private lastManifest?: Record<string, unknown>;

  constructor(
    private readonly k8sClient: K8sApiClient,
    private readonly packager: ArtifactPackager,
    private readonly manifestBuilder: ManifestBuilder
  ) {}

  getLastManifest(): Record<string, unknown> | undefined {
    return this.lastManifest;
  }

  async runFromActivePythonFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      vscode.window.showErrorMessage('Open a Python file first.');
      return;
    }

    const settings = getSettings();
    const scriptPath = editor.document.uri.fsPath;
    const defaultName = `ptjob-${Date.now().toString().slice(-6)}`;

    const name = await vscode.window.showInputBox({ prompt: 'Job name', value: defaultName });
    if (!name) return;

    const image =
      (await vscode.window.showInputBox({ prompt: 'Container image', value: settings.defaultImage })) ??
      settings.defaultImage;

    const gpu = Number((await vscode.window.showInputBox({ prompt: 'GPU count', value: '1' })) ?? '1');
    const cpu = (await vscode.window.showInputBox({ prompt: 'CPU', value: '2' })) ?? '2';
    const memory = (await vscode.window.showInputBox({ prompt: 'RAM', value: '16Gi' })) ?? '16Gi';
    const namespace =
      (await vscode.window.showInputBox({ prompt: 'Namespace', value: settings.defaultNamespace })) ??
      settings.defaultNamespace;
    const pipDeps = (await vscode.window.showInputBox({ prompt: 'pip dependencies (comma-separated)', value: '' })) ?? '';
    const aptDeps = (await vscode.window.showInputBox({ prompt: 'apt dependencies (comma-separated)', value: '' })) ?? '';

    const options: JobOptions = {
      name,
      namespace,
      image,
      gpu: Number.isFinite(gpu) ? gpu : 1,
      cpu,
      memory,
      scriptPath,
      pip: splitCsv(pipDeps),
      apt: splitCsv(aptDeps),
      autoPVCforPip: settings.autoPVCforPip
    };

    const archive = await this.packager.packageToTarGz(scriptPath);
    const encoded = await this.packager.readBase64(archive);

    const cmName = `${name}-artifact`;
    const configMap = this.manifestBuilder.buildArtifactConfigMap(namespace, cmName, encoded);
    await this.k8sClient.createCoreObject(namespace, 'configmaps', configMap);

    if (options.autoPVCforPip) {
      const pvc = this.manifestBuilder.buildPVC('pip-cache-pvc', namespace, settings.defaultPVCsize);
      try {
        await this.k8sClient.createCoreObject(namespace, 'persistentvolumeclaims', pvc);
      } catch {
        // likely already exists
      }
    }

    const manifest = this.manifestBuilder.buildPyTorchJob(options, cmName);
    this.lastManifest = manifest;
    await this.k8sClient.createCustomObject('kubeflow.org', 'v1', namespace, 'pytorchjobs', manifest);

    vscode.window.showInformationMessage(`Kubeflow job ${name} submitted.`);
  }
}

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
