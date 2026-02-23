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
    clientId: cfg.get('kflow.keycloak.clientId', 'kubeflow-vscode'),
    templatesFile: cfg.get('kflow.templatesFile', '.kubeflow/templates.json'),
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
    const clientId = String(settings.clientId || 'kubeflow-vscode').trim();
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: clientId,
        username,
        password
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(this.buildAuthErrorMessage(res.status, body, tokenEndpoint, clientId));
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
    const clientId = String(settings.clientId || 'kubeflow-vscode').trim();

    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: this.session.refreshToken
      })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(this.buildAuthErrorMessage(res.status, body, tokenEndpoint, clientId));
    }
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

  buildAuthErrorMessage(status, body, tokenEndpoint, clientId) {
    let details = String(body || '').trim();

    try {
      const parsed = JSON.parse(body);
      const err = parsed && parsed.error ? String(parsed.error) : '';
      const desc = parsed && parsed.error_description ? String(parsed.error_description) : '';
      details = [err, desc].filter(Boolean).join(': ') || details;

      if (err === 'invalid_client' || err === 'unauthorized_client') {
        return `Authentication failed (${status}): ${details}. Verify Keycloak client "${clientId}" exists, is public or has proper secret, and has Direct Access Grants enabled.`;
      }

      if (err === 'invalid_grant') {
        return `Authentication failed (${status}): ${details}. Credentials may be correct, but user can be blocked by required actions, temporary disablement, or missing password grant permissions in Keycloak.`;
      }
    } catch {
      // Keep raw response when body is not JSON.
    }

    return `Authentication failed (${status}) at ${tokenEndpoint}: ${details}`;
  }

  resolveTokenEndpoint(url, realm) {
    const explicitTokenUrl = getSettings().tokenUrl;
    if (explicitTokenUrl) {
      const tokenUrl = String(explicitTokenUrl).trim();
      if (!/^https?:\/\//i.test(tokenUrl)) {
        throw new Error('Invalid "kflow.keycloak.tokenUrl": expected absolute URL starting with http:// or https://.');
      }
      return tokenUrl.replace(/\/$/, '');
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

  async getCustomObject(group, version, namespace, plural, name) {
    return this.request(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`);
  }

  async deleteCustomObject(group, version, namespace, plural, name) {
    return this.request(`/apis/${group}/${version}/namespaces/${namespace}/${plural}/${name}`, {
      method: 'DELETE'
    });
  }

  async getPodLogs(namespace, podName, containerName) {
    const qs = new URLSearchParams({ follow: 'false', tailLines: '200' });
    if (containerName) qs.set('container', containerName);
    return this.requestRaw(`/api/v1/namespaces/${namespace}/pods/${podName}/log?${qs.toString()}`);
  }

  async listPodsByJob(namespace, jobName) {
    const qs = new URLSearchParams({ labelSelector: `training.kubeflow.org/job-name=${jobName}` });
    return this.request(`/api/v1/namespaces/${namespace}/pods?${qs.toString()}`);
  }

  async requestRaw(pathSuffix, init = {}) {
    await this.authService.ensureValidSession();
    const settings = getSettings();
    const token = this.authService.getAccessToken();
    if (!settings.url) throw new Error('kflow.url is empty. Set it in settings.');

    const url = `${settings.url.replace(/\/$/, '')}${pathSuffix}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.headers || {})
      }
    });

    if (!res.ok) throw new Error(`Kubernetes API error ${res.status}: ${await res.text()}`);
    return res.text();
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

  async listJobs(namespace) {
    const payload = await this.k8sClient.list(namespace, '/apis/kubeflow.org/v1/namespaces/{namespace}/pytorchjobs');
    return payload.items || [];
  }

  async describeJob(namespace, name) {
    return this.k8sClient.getCustomObject('kubeflow.org', 'v1', namespace, 'pytorchjobs', name);
  }

  async deleteJob(namespace, name) {
    await this.k8sClient.deleteCustomObject('kubeflow.org', 'v1', namespace, 'pytorchjobs', name);
  }

  async restartLastRun() {
    if (!this.lastManifest) {
      throw new Error('No previous manifest available. Run a job first.');
    }
    const manifest = JSON.parse(JSON.stringify(this.lastManifest));
    const namespace = manifest?.metadata?.namespace || getSettings().defaultNamespace;
    const oldName = manifest?.metadata?.name || 'ptjob';
    const newName = `${oldName}-restart-${Date.now().toString().slice(-4)}`;
    manifest.metadata.name = newName;
    delete manifest.metadata.resourceVersion;
    delete manifest.metadata.uid;
    delete manifest.metadata.creationTimestamp;

    await this.k8sClient.createCustomObject('kubeflow.org', 'v1', namespace, 'pytorchjobs', manifest);
    this.lastManifest = manifest;
    return newName;
  }

  async streamJobLogs(namespace, jobName, outputChannel) {
    const pods = await this.k8sClient.listPodsByJob(namespace, jobName);
    const items = pods.items || [];
    if (items.length === 0) {
      throw new Error(`No pods found for job ${jobName}.`);
    }

    const pickedPod =
      (await vscode.window.showQuickPick(
        items.map((p) => ({
          label: p.metadata?.name || 'unnamed-pod',
          description: p.status?.phase || ''
        })),
        { placeHolder: 'Select pod for log streaming' }
      )) || items[0];

    const podName = pickedPod.label ? pickedPod.label : pickedPod.metadata?.name;
    const containerName = items.find((p) => p.metadata?.name === podName)?.spec?.containers?.[0]?.name;
    const logs = await this.k8sClient.getPodLogs(namespace, podName, containerName);

    outputChannel.clear();
    outputChannel.show(true);
    outputChannel.appendLine(`[Kubeflow] Logs for job=${jobName}, pod=${podName}`);

    for (const line of logs.split('\n')) {
      outputChannel.appendLine(colorizeLogLine(line));
    }
  }

  async runFromTemplate() {
    const template = await pickTemplateFromWorkspace();
    if (!template) return;

    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'python') {
      throw new Error('Open a Python file first to run template-based job.');
    }

    const settings = getSettings();
    const scriptPath = editor.document.uri.fsPath;
    const name = `ptjob-${Date.now().toString().slice(-6)}`;

    const options = {
      name,
      namespace: template.namespace || settings.defaultNamespace,
      image: template.image || settings.defaultImage,
      gpu: Number.isFinite(Number(template.gpu)) ? Number(template.gpu) : 1,
      cpu: String(template.cpu || '2'),
      memory: String(template.mem || template.memory || '16Gi'),
      scriptPath,
      pip: Array.isArray(template.pip) ? template.pip : [],
      apt: Array.isArray(template.apt) ? template.apt : [],
      autoPVCforPip: template.autoPVCforPip !== undefined ? Boolean(template.autoPVCforPip) : settings.autoPVCforPip
    };

    await this.submitRun(options, settings);
    return options.name;
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

    await this.submitRun(options, settings);
    vscode.window.showInformationMessage(`Kubeflow job ${name} submitted.`);
  }

  async submitRun(options, settings) {
    const archive = await this.packager.packageToTarGz(options.scriptPath);
    const encoded = await this.packager.readBase64(archive);

    const cmName = `${options.name}-artifact`;
    await this.k8sClient.createCoreObject(
      options.namespace,
      'configmaps',
      this.manifestBuilder.buildArtifactConfigMap(options.namespace, cmName, encoded)
    );

    if (options.autoPVCforPip) {
      try {
        await this.k8sClient.createCoreObject(
          options.namespace,
          'persistentvolumeclaims',
          this.manifestBuilder.buildPVC('pip-cache-pvc', options.namespace, settings.defaultPVCsize)
        );
      } catch {
        // likely exists already
      }
    }

    const manifest = this.manifestBuilder.buildPyTorchJob(options, cmName);
    this.lastManifest = manifest;
    await this.k8sClient.createCustomObject('kubeflow.org', 'v1', options.namespace, 'pytorchjobs', manifest);
  }
}

function splitCsv(value) {
  return String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function colorizeLogLine(line) {
  if (line.includes('ERROR') || line.includes('Traceback')) return `[ERROR] ${line}`;
  if (line.includes('WARN')) return `[WARN] ${line}`;
  return line;
}

async function pickTemplateFromWorkspace() {
  const settings = getSettings();
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) throw new Error('Open a workspace folder to use templates.');

  const templatesPath = path.join(workspaceFolder.uri.fsPath, settings.templatesFile);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(templatesPath, 'utf-8'));
  } catch {
    throw new Error(`Cannot read templates file: ${templatesPath}`);
  }

  const templates = Array.isArray(payload?.templates) ? payload.templates : Array.isArray(payload) ? payload : [];
  if (templates.length === 0) {
    throw new Error(`No templates found in ${templatesPath}.`);
  }

  const picked = await vscode.window.showQuickPick(
    templates.map((t) => ({ label: t.name || t.image || 'template', description: t.namespace || '', template: t })),
    { placeHolder: 'Select Kubeflow template' }
  );

  return picked?.template;
}

function registerCommands(context, authService, jobRunService, treeProvider) {
  const logsChannel = vscode.window.createOutputChannel('Kubeflow Logs');
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
            'Kubeflow login failed (403). Check kflow.keycloak.realm/tokenUrl and verify Keycloak client settings (kflow.keycloak.clientId, Direct Access Grants).'
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
    vscode.commands.registerCommand('kubeflow.runTrainingJobFromTemplate', async () => {
      try {
        const name = await jobRunService.runFromTemplate();
        if (name) vscode.window.showInformationMessage(`Kubeflow template job ${name} submitted.`);
        treeProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Template run failed: ${String(e)}`);
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
    vscode.commands.registerCommand('kubeflow.deleteTrainingJob', async () => {
      try {
        const namespace = getSettings().defaultNamespace;
        const jobs = await jobRunService.listJobs(namespace);
        const picked = await vscode.window.showQuickPick(
          jobs.map((j) => ({ label: j.metadata?.name || 'unnamed' })),
          { placeHolder: 'Select job to delete' }
        );
        if (!picked) return;
        await jobRunService.deleteJob(namespace, picked.label);
        vscode.window.showInformationMessage(`Deleted job ${picked.label}.`);
        treeProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Delete job failed: ${String(e)}`);
      }
    }),
    vscode.commands.registerCommand('kubeflow.describeJob', async () => {
      try {
        const namespace = getSettings().defaultNamespace;
        const jobs = await jobRunService.listJobs(namespace);
        const picked = await vscode.window.showQuickPick(
          jobs.map((j) => ({ label: j.metadata?.name || 'unnamed' })),
          { placeHolder: 'Select job to describe' }
        );
        if (!picked) return;
        const details = await jobRunService.describeJob(namespace, picked.label);
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(details, null, 2) });
        await vscode.window.showTextDocument(doc, { preview: false });
      } catch (e) {
        vscode.window.showErrorMessage(`Describe job failed: ${String(e)}`);
      }
    }),
    vscode.commands.registerCommand('kubeflow.createPVC', () => vscode.window.showInformationMessage('Create PVC is scaffolded.')),
    vscode.commands.registerCommand('kubeflow.restartJob', async () => {
      try {
        const name = await jobRunService.restartLastRun();
        vscode.window.showInformationMessage(`Restarted job as ${name}.`);
        treeProvider.refresh();
      } catch (e) {
        vscode.window.showErrorMessage(`Restart failed: ${String(e)}`);
      }
    }),
    vscode.commands.registerCommand('kubeflow.streamJobLogs', async () => {
      try {
        const namespace = getSettings().defaultNamespace;
        const jobs = await jobRunService.listJobs(namespace);
        const picked = await vscode.window.showQuickPick(
          jobs.map((j) => ({ label: j.metadata?.name || 'unnamed' })),
          { placeHolder: 'Select job to stream logs' }
        );
        if (!picked) return;
        await jobRunService.streamJobLogs(namespace, picked.label, logsChannel);
      } catch (e) {
        vscode.window.showErrorMessage(`Stream logs failed: ${String(e)}`);
      }
    }),
    logsChannel
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
