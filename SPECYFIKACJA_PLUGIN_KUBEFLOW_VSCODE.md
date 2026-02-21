# Implementation Specification: VS Code Plugin for Kubeflow Training

This document translates the provided functional and non-functional requirements into an implementation plan, architecture, and acceptance criteria.

## 1. Product Goal

The plugin must let users run and monitor Kubeflow training jobs without writing YAML and without using `kubectl` manually.

**UX principle:** “zero YAML, zero kubectl, zero terminal login”.

---

## 2. Functional Scope

### 2.1 Authentication and credentials

#### FR-1. Keycloak login (two-stage)
- Implement the two-stage auth flow:
  1. redirect to auth endpoint,
  2. Keycloak login,
  3. session acquisition (cookies/session tokens).
- No terminal-based login.
- First run shows popup:
  - Kubeflow URL,
  - username,
  - password,
  - `Sign in` button.

#### FR-2. Automatic session refresh
- Track cookie/session-token expiration.
- Refresh session before expiry (e.g., 5-minute safety window).
- Retry with backoff and refresh UI state after success.

#### FR-3. Credential storage
- Sensitive data only in `vscode.SecretStorage`.
- Never persist plaintext password in local files.
- Provide `Sign out` command to clear secrets and in-memory session.

### 2.2 Kubernetes API connection

#### FR-4. Ephemeral kubeconfig
- Generate kubeconfig in-memory from active session.
- User does not edit kubeconfig manually.
- Regenerate/refresh kubeconfig when session is refreshed.

#### FR-5. Kubeflow resource browsing
- List and inspect:
  - TrainingJobs: `PyTorchJob`, `TFJob`, `MPIJob`,
  - `PVC`, `ConfigMap`, `Notebooks`, `Pipelines`.
- Show job logs.

### 2.3 Training job execution — no YAML

#### FR-6. Quick run from `.py`
- Editor context action: `Run as Kubeflow Training Job`.
- Wizard fields:
  - job type (default `PyTorchJob`),
  - job name,
  - image (dropdown based on available images),
  - GPU / CPU / RAM,
  - pip dependencies,
  - apt dependencies,
  - namespace,
  - auto PVC for pip cache,
  - script path (defaults to active file).
- YAML generated internally, not required in the user flow.

#### FR-7. Code upload mode
- Default: package code as `tar.gz` for each run.
- Optional compatibility mode: `ConfigMap` upload.

#### FR-8. Automatic PVC for pip cache
- Create `pip-cache-pvc` if it does not exist.
- Mount PVC in job container.

### 2.4 Job debugging

#### FR-9. Live logs
- Stream logs in real time (equivalent to `kubectl logs -f`, implemented via API).
- Error/warning highlighting.
- `Open in new panel` action.

#### FR-10. Restart without reconfiguration
- `Restart job` action without re-entering settings.
- Reuse stored run spec (manifest + parameters).

#### FR-11. View generated YAML (optional)
- Read-only preview of generated manifest.

### 2.5 VS Code integration

#### FR-12. Explorer sidebar: `KUBEFLOW PANEL`
Sections:
- Jobs,
- Notebooks,
- PVC,
- ConfigMaps,
- Pipelines,
- Model Registry.

Clicking a job shows:
- status,
- details,
- logs,
- retry/restart actions.

#### FR-13. Command Palette
Commands:
- `Kubeflow: Login`
- `Kubeflow: Run Training Job`
- `Kubeflow: Open Dashboard`
- `Kubeflow: Create Notebook`
- `Kubeflow: Delete Training Job`
- `Kubeflow: Describe Job`
- `Kubeflow: Create PVC`

### 2.6 Notebook management (optional, high UX value)

#### FR-14. Notebook server lifecycle
- Create Kubeflow Notebook Server from VS Code.
- Select image and GPU count.
- Auto port-forward and open notebook as remote workflow.

### 2.7 Configuration (`settings.json`)

#### FR-15. Settings keys
```json
"kflow.url": "",
"kflow.verifySSL": true,
"kflow.keycloak.realm": "",
"kflow.defaultNamespace": "",
"kflow.defaultImage": "",
"kflow.defaultPVCsize": "10Gi",
"kflow.autoPVCforPip": true
```

### 2.8 Advanced templates

#### FR-16. Job templates
- Support JSON templates (local and/or workspace).
- `Run using template -> <TemplateName>` flow.
- Example:
```json
{
  "image": "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime",
  "gpu": 1,
  "cpu": 2,
  "mem": "16Gi",
  "pip": ["geopandas", "terratorch"],
  "apt": ["libgdal-dev", "libjpeg-dev"]
}
```

---

## 3. Technical Architecture

### 3.1 Backend (Node.js extension host)
Components:
1. `AuthService`
   - Keycloak two-stage login,
   - refresh,
   - sign out,
   - integration with `SecretStorage`.
2. `KubeSessionService`
   - build ephemeral kubeconfig,
   - refresh after token/session updates.
3. `ArtifactPackager`
   - package source code as `tar.gz`,
   - ConfigMap fallback.
4. `ManifestBuilder`
   - build manifests (`PyTorchJob`, PVC, ConfigMap),
   - inject pip/apt/script startup commands.
5. `K8sApiClient`
   - resource CRUD via REST API,
   - watch/list/get/delete,
   - log streaming.
6. `JobRunService`
   - end-to-end orchestration for job runs.

### 3.2 Frontend (VS Code UI)
1. `TreeDataProvider` for Kubeflow panel.
2. Webview / QuickPick run wizard.
3. Log panel with filtering and highlight rules.
4. Command registrations for command palette and context menus.

### 3.3 API integrations
- Kubernetes REST API.
- Kubeflow Training Operator CRD API.
- KFP API (optional for Pipelines).
- Model Registry API (optional).

---

## 4. Minimal E2E UX Flow

1. User clicks `Run on Kubeflow`.
2. Plugin performs Keycloak auto-login (or reuses active session).
3. Wizard collects minimal parameters (image, GPU, namespace).
4. Plugin packages code as `tar.gz`.
5. Plugin uploads artifact (or uses ConfigMap mode).
6. Plugin validates/creates `pip-cache-pvc`.
7. Plugin generates and submits `PyTorchJob` manifest.
8. Plugin opens logs and status panel.
9. Plugin updates status: Running / Succeeded / Failed.

---

## 5. Manifest Generator Requirements

Generated manifests must support:
- PVC + mount for pip cache,
- volume mounts for code and cache,
- startup command chain:
  - `apt-get install ...`
  - `pip install ...`
  - `python <script_path>`
- CPU/RAM/GPU resource configuration,
- namespace and metadata labels.

---

## 6. Non-Functional Requirements

### NFR-1 Security
- Sensitive values only in `SecretStorage`.
- No plaintext password persistence.
- Automatic session refresh and expiration handling.

### NFR-2 Compatibility
- Kubeflow `1.6+`.
- PyTorchJob operator `v1`.
- VS Code `>= 1.90`.

### NFR-3 Performance
- Kubeflow panel load time: < 2 s in typical clusters.
- Run wizard opening time: < 500 ms.
- Paginated listing for large namespaces.
- Debounce and short-TTL cache for images/pods lists.

### NFR-4 Reliability
- Retry/backoff for API 5xx and timeout failures.
- Detect session loss and trigger auto-relogin flow.
- Clear user-facing errors + telemetry event IDs.

---

## 7. Delivery Roadmap (MVP -> v2)

### MVP (must-have)
- Keycloak two-stage login.
- SecretStorage + sign out.
- Quick-run `.py` -> `PyTorchJob`.
- `tar.gz` artifact upload.
- Auto PVC for pip cache.
- Live logs.
- Kubeflow panel: Jobs + PVC + ConfigMaps.

### V1.1
- TFJob / MPIJob support.
- View generated YAML.
- Restart job.
- JSON templates.

### V1.2
- Notebook lifecycle support.
- Basic Pipelines and Model Registry actions.

---

## 8. Acceptance Criteria (Definition of Done)

1. User runs a `.py` file as a training job without creating YAML.
2. User does not need to run `kubectl`.
3. Session refresh happens automatically without re-entering password.
4. Password is never present in config files or logs.
5. Job supports pip/apt dependencies and optional pip-cache PVC.
6. Logs stream live and can be opened in a separate panel.
7. Command palette commands work as specified.

---

## 9. Risks and Mitigations

1. **Keycloak deployment differences across environments**
   - Mitigation: endpoint adapter + configurable realm/path.
2. **ConfigMap size limitations**
   - Mitigation: default to `tar.gz`, keep ConfigMap as fallback.
3. **CRD compatibility differences across cluster versions**
   - Mitigation: capability detection + manifest mapping layer.
4. **Performance issues with large job counts**
   - Mitigation: lazy loading, pagination, watch-based updates instead of polling.

---

## 10. Recommended Code Module Layout

- `src/auth/*`
- `src/kube/*`
- `src/manifest/*`
- `src/artifacts/*`
- `src/jobs/*`
- `src/ui/tree/*`
- `src/ui/webview/*`
- `src/commands/*`

This structure cleanly separates domain logic (auth, manifests, API) from UI logic and improves testability.
