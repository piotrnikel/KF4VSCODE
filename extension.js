const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);

const ACCESS_TOKEN_KEY = 'kflow.accessToken';
const REFRESH_TOKEN_KEY = 'kflow.refreshToken';
const EXPIRES_AT_KEY = 'kflow.expiresAt';

function getSettings() {
  const cfg = vscode.workspace.getConfiguration();
  return {
    url: cfg.get('kflow.url', ''),
    verifySSL: cfg.get('kflow.verifySSL', true),
    realm: cfg.get('kflow.keycloak.realm', ''),
    tokenUrl: cfg.get('kflow.keycloak.tokenUrl', ''),
    defaultNamespace: cfg.get('kflow.defaultNamespace', 'kubeflow-user'),
    defaultImage: cfg.get('kflow.defaultImage', 'pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime'),
    defaultPVCsize: cfg.get('kflow.defaultPVCsize', '10Gi'),
    autoPVCforPip: cfg.get('kflow.autoPVCforPip', true)
  };
}

class AuthService {
  constructor(secrets) {
    this.secrets = secrets;
    this.session = undefined;
    this.refreshTimer = undefined;
  }

  async initialize() {
    const accessToken = await this.secrets.get(ACCESS_TOKEN_KEY);
    if (!accessToken) return;
    const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
    const expiresRaw = await this.secrets.get(EXPIRES_AT_KEY);
    const expiresAt = expiresRaw ? Number(expiresRaw) : Date.now();
    this.session = { accessToken, refreshToken: refreshToken || undefined, expiresAt };
    this.scheduleRefresh();
  }

  async loginInteractive() {
    const settings = getSettings();
    const url = await vscode.window.showInputBox({ prompt: 'Kubeflow URL', value: settings.url });
    if (!url) return;
    const username = await vscode.window.showInputBox({ prompt: 'Username' });
    if (!username) return;
    const password = await vscode.window.showInputBox({ prompt: 'Password', password: true });
    if (!password) return;

    const tokenEndpoint = this.resolveTokenEndpoint(url, settings.realm);
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'kubeflow-vscode',
        username,
        password
      })
    });

    if (!res.ok) {
      throw new Error(`Authentication failed (${res.status}): ${await res.text()}`);
    }

    const payload = await res.json();
    await this.setSession({
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
      expiresAt: Date.now() + Number(payload.expires_in || 300) * 1000
    });
  }

  getAccessToken() {
    return this.session && this.session.accessToken;
  }

  async ensureValidSession() {
    if (!this.session) throw new Error('Not logged in. Run "Kubeflow: Login" first.');
    if (Date.now() + 5 * 60 * 1000 < this.session.expiresAt) return;
    await this.refreshSession();
  }

  async signOut() {
    this.session = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await Promise.all([
      this.secrets.delete(ACCESS_TOKEN_KEY),
      this.secrets.delete(REFRESH_TOKEN_KEY),
      this.secrets.delete(EXPIRES_AT_KEY)
    ]);
  }

  async refreshSession() {
    if (!this.session || !this.session.refreshToken) throw new Error('No refresh token is available.');
    const settings = getSettings();
    const tokenEndpoint = this.resolveTokenEndpoint(settings.url, settings.realm);

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: 'kubeflow-vscode',
        refresh_token: this.session.refreshToken
      })
    });

    if (!res.ok) throw new Error(`Session refresh failed (${res.status}).`);
    const payload = await res.json();
    await this.setSession({
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : this.session.refreshToken,
      expiresAt: Date.now() + Number(payload.expires_in || 300) * 1000
    });
  }

  async setSession(session) {
    this.session = session;
    await this.secrets.store(ACCESS_TOKEN_KEY, session.accessToken);
    if (session.refreshToken) await this.secrets.store(REFRESH_TOKEN_KEY, session.refreshToken);
    await this.secrets.store(EXPIRES_AT_KEY, String(session.expiresAt));
    this.scheduleRefresh();
  }

  scheduleRefresh() {
    if (!this.session) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delayMs = Math.max(10000, this.session.expiresAt - Date.now() - 5 * 60 * 1000);
    this.refreshTimer = setTimeout(() => {
      this.refreshSession().catch(async (err) => {
        vscode.window.showWarningMessage(`Kubeflow session refresh failed: ${String(err)}`);
        await this.signOut();
      });
    }, delayMs);
  }

  resolveTokenEndpoint(url, realm) {
    const explicitTokenUrl = getSettings().tokenUrl;
    if (explicitTokenUrl) {
      return String(explicitTokenUrl).replace(/\/$/, '');
    }

    const realmValue = String(realm || '').trim();

    if (/^https?:\/\//i.test(realmValue)) {
      // Accept full realm URL, e.g. https://kc.example.com/realms/kubeflow
      // and convert it to token endpoint.
      return `${realmValue.replace(/\/$/, '')}/protocol/openid-connect/token`;
    }

    const base = String(url).replace(/\/$/, '');
    const r = realmValue || 'kubeflow';
    return `${base}/realms/${r}/protocol/openid-connect/token`;
  }

  dispose() {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}

class K8sApiClient {
  constructor(authService) {
    this.authService = authService;
  }

  async createCustomObject(group, version, namespace, plural, body) {
    return this.request(`/apis/${group}/${version}/namespaces/${namespace}/${plural}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async createCoreObject(namespace, plural, body) {
    return this.request(`/api/v1/namespaces/${namespace}/${plural}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async list(namespace, pathTemplate) {
    return this.request(pathTemplate.replace('{namespace}', namespace));
  }

  async request(pathSuffix, init = {}) {
    await this.authService.ensureValidSession();
    const settings = getSettings();
    const token = this.authService.getAccessToken();
    if (!settings.url) throw new Error('kflow.url is empty. Set it in settings.');

    const url = `${settings.url.replace(/\/$/, '')}${pathSuffix}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });

    if (!res.ok) throw new Error(`Kubernetes API error ${res.status}: ${await res.text()}`);
    return res.status === 204 ? {} : res.json();
  }
}

class ManifestBuilder {
  buildPVC(name, namespace, size) {
    return {
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name, namespace },
      spec: {
        accessModes: ['ReadWriteOnce'],
        resources: { requests: { storage: size } }
      }
    };
  }

  buildArtifactConfigMap(namespace, name, encodedTarGz) {
    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace },
      data: { 'artifact.tar.gz.base64': encodedTarGz }
    };
  }

  buildPyTorchJob(options, artifactConfigMapName) {
    const aptInstall = options.apt.length ? `apt-get update && apt-get install -y ${options.apt.join(' ')} && ` : '';
    const pipInstall = options.pip.length ? `pip install ${options.pip.join(' ')} && ` : '';
    const cmd = `${aptInstall}${pipInstall}python ${options.scriptPath}`;

    return {
      apiVersion: 'kubeflow.org/v1',
      kind: 'PyTorchJob',
      metadata: {
        name: options.name,
        namespace: options.namespace,
        labels: { 'app.kubernetes.io/managed-by': 'kubeflow-vscode' }
      },
      spec: {
        pytorchReplicaSpecs: {
          Master: {
            replicas: 1,
            restartPolicy: 'OnFailure',
            template: {
              spec: {
                containers: [
                  {
                    name: 'pytorch',
                    image: options.image,
                    command: ['/bin/sh', '-c', cmd],
                    resources: {
                      limits: {
                        'nvidia.com/gpu': options.gpu,
                        cpu: options.cpu,
                        memory: options.memory
                      },
                      requests: {
                        cpu: options.cpu,
                        memory: options.memory
                      }
                    },
                    volumeMounts: [
                      { name: 'job-code', mountPath: '/workspace' },
                      ...(options.autoPVCforPip ? [{ name: 'pip-cache', mountPath: '/root/.cache/pip' }] : [])
                    ]
                  }
                ],
                volumes: [
                  { name: 'job-code', configMap: { name: artifactConfigMapName } },
                  ...(options.autoPVCforPip
                    ? [{ name: 'pip-cache', persistentVolumeClaim: { claimName: 'pip-cache-pvc' } }]
                    : [])
                ]
              }
            }
          }
        }
      }
    };
  }
}

class ArtifactPackager {
  async packageToTarGz(sourceFileOrDir) {
    const abs = path.resolve(sourceFileOrDir);
    const stat = await fs.stat(abs);
    const sourceDir = stat.isDirectory() ? abs : path.dirname(abs);
    const archivePath = path.join(sourceDir, `.kflow-artifact-${Date.now()}.tar.gz`);
    await execFileAsync('tar', ['-czf', archivePath, '-C', sourceDir, '.']);
    return archivePath;
  }

  async readBase64(archivePath) {
    const bytes = await fs.readFile(archivePath);
    return bytes.toString('base64');
  }
}

class KubeflowTreeProvider {
  constructor(k8sClient) {
    this.k8sClient = k8sClient;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element) {
    return element;
  }

  async getChildren(element) {
    if (!element) {
      return ['Jobs', 'Notebooks', 'PVC', 'ConfigMaps', 'Pipelines', 'Model Registry'].map((label) => {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.contextValue = 'kubeflowCategory';
        item.description = '';
        return item;
      });
    }

    const namespace = vscode.workspace.getConfiguration().get('kflow.defaultNamespace', 'kubeflow-user');

    try {
      if (element.label === 'Jobs') {
        const jobs = await this.k8sClient.list(namespace, '/apis/kubeflow.org/v1/namespaces/{namespace}/pytorchjobs');
        return (jobs.items || []).map((j) => {
          const job = new vscode.TreeItem(j.metadata?.name || 'unnamed', vscode.TreeItemCollapsibleState.None);
          job.description = j.status?.conditions?.[0]?.type || '';
          return job;
        });
      }
    } catch (_e) {
      return [new vscode.TreeItem('Login required or API unavailable', vscode.TreeItemCollapsibleState.None)];
    }

    return [new vscode.TreeItem('Not implemented yet', vscode.TreeItemCollapsibleState.None)];
  }
}

class JobRunService {
  constructor(k8sClient, packager, manifestBuilder) {
    this.k8sClient = k8sClient;
    this.packager = packager;
    this.manifestBuilder = manifestBuilder;
    this.lastManifest = undefined;
  }

  getLastManifest() {
    return this.lastManifest;
  }

  async runFromActivePythonFile() {
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
    const image = (await vscode.window.showInputBox({ prompt: 'Container image', value: settings.defaultImage })) || settings.defaultImage;
    const gpu = Number((await vscode.window.showInputBox({ prompt: 'GPU count', value: '1' })) || '1');
    const cpu = (await vscode.window.showInputBox({ prompt: 'CPU', value: '2' })) || '2';
    const memory = (await vscode.window.showInputBox({ prompt: 'RAM', value: '16Gi' })) || '16Gi';
    const namespace = (await vscode.window.showInputBox({ prompt: 'Namespace', value: settings.defaultNamespace })) || settings.defaultNamespace;
    const pip = splitCsv((await vscode.window.showInputBox({ prompt: 'pip dependencies (comma-separated)', value: '' })) || '');
    const apt = splitCsv((await vscode.window.showInputBox({ prompt: 'apt dependencies (comma-separated)', value: '' })) || '');

    const options = {
      name,
      namespace,
      image,
      gpu: Number.isFinite(gpu) ? gpu : 1,
      cpu,
      memory,
      scriptPath,
      pip,
      apt,
      autoPVCforPip: settings.autoPVCforPip
    };

    const archive = await this.packager.packageToTarGz(scriptPath);
    const encoded = await this.packager.readBase64(archive);

    const cmName = `${name}-artifact`;
    await this.k8sClient.createCoreObject(namespace, 'configmaps', this.manifestBuilder.buildArtifactConfigMap(namespace, cmName, encoded));

    if (options.autoPVCforPip) {
      try {
        await this.k8sClient.createCoreObject(
          namespace,
          'persistentvolumeclaims',
          this.manifestBuilder.buildPVC('pip-cache-pvc', namespace, settings.defaultPVCsize)
        );
      } catch {
        // no-op (already exists)
      }
    }

    const manifest = this.manifestBuilder.buildPyTorchJob(options, cmName);
    this.lastManifest = manifest;
    await this.k8sClient.createCustomObject('kubeflow.org', 'v1', namespace, 'pytorchjobs', manifest);
    vscode.window.showInformationMessage(`Kubeflow job ${name} submitted.`);
  }
}

function splitCsv(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function registerCommands(context, authService, jobRunService, treeProvider) {
  context.subscriptions.push(
    vscode.commands.registerCommand('kubeflow.login', async () => {
      try {
        await authService.loginInteractive();
        vscode.window.showInformationMessage('Kubeflow login successful.');
        treeProvider.refresh();
      } catch (e) {
        const errorMsg = String(e);
        if (errorMsg.includes('Authentication failed (403)')) {
          vscode.window.showErrorMessage(
            'Kubeflow login failed (403). Check kflow.keycloak.realm (realm name, not UI URL) or set kflow.keycloak.tokenUrl directly.'
          );
        } else {
          vscode.window.showErrorMessage(`Kubeflow login failed: ${errorMsg}`);
        }
      }
    }),
    vscode.commands.registerCommand('kubeflow.signOut', async () => {
      await authService.signOut();
      vscode.window.showInformationMessage('Kubeflow session cleared.');
      treeProvider.refresh();
    }),
    vscode.commands.registerCommand('kubeflow.runTrainingJob', async () => {
      try {
        await jobRunService.runFromActivePythonFile();
        treeProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Run failed: ${String(e)}`);
      }
    }),
    vscode.commands.registerCommand('kubeflow.viewGeneratedYaml', async () => {
      const manifest = jobRunService.getLastManifest();
      if (!manifest) return vscode.window.showInformationMessage('No generated manifest yet.');
      const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(manifest, null, 2) });
      await vscode.window.showTextDocument(doc, { preview: false });
    }),
    vscode.commands.registerCommand('kubeflow.openDashboard', async () => {
      const url = getSettings().url;
      if (!url) return vscode.window.showWarningMessage('Configure kflow.url first.');
      await vscode.env.openExternal(vscode.Uri.parse(url));
    }),
    vscode.commands.registerCommand('kubeflow.refreshPanel', () => treeProvider.refresh()),
    vscode.commands.registerCommand('kubeflow.createNotebook', () => vscode.window.showInformationMessage('Create Notebook is planned for next iteration.')),
    vscode.commands.registerCommand('kubeflow.deleteTrainingJob', () => vscode.window.showInformationMessage('Delete Training Job is scaffolded.')),
    vscode.commands.registerCommand('kubeflow.describeJob', () => vscode.window.showInformationMessage('Describe Job is scaffolded.')),
    vscode.commands.registerCommand('kubeflow.createPVC', () => vscode.window.showInformationMessage('Create PVC is scaffolded.')),
    vscode.commands.registerCommand('kubeflow.restartJob', () => vscode.window.showInformationMessage('Restart Job is scaffolded.'))
  );
}

async function activate(context) {
  const authService = new AuthService(context.secrets);
  await authService.initialize();

  const k8sClient = new K8sApiClient(authService);
  const jobRunService = new JobRunService(k8sClient, new ArtifactPackager(), new ManifestBuilder());
  const treeProvider = new KubeflowTreeProvider(k8sClient);

  vscode.window.registerTreeDataProvider('kubeflowPanel', treeProvider);
  registerCommands(context, authService, jobRunService, treeProvider);

  context.subscriptions.push(authService);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
