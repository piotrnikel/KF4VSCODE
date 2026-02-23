# Kubeflow Training VS Code Extension (drop-in runtime build)

This extension is packaged to run **without any TypeScript build step**.

## Quick installation

1. Copy this folder into your VS Code extensions directory:
   - Linux/macOS: `~/.vscode/extensions/kubeflow-vscode-plugin`
   - Windows: `%USERPROFILE%\\.vscode\\extensions\\kubeflow-vscode-plugin`
2. Restart VS Code.
3. Open Command Palette and run `Kubeflow: Login`.

No `npm install` and no compile step are required for runtime.

---

## Core commands

- `Kubeflow: Login`
- `Kubeflow: Sign out`
- `Kubeflow: Run Training Job`
- `Kubeflow: Run Training Job (Template)`
- `Kubeflow: View Generated YAML`
- `Kubeflow: Describe Job`
- `Kubeflow: Delete Training Job`
- `Kubeflow: Restart Job`
- `Kubeflow: Stream Job Logs`

---

## Settings

Minimal login settings:

```json
"kflow.url": "https://<kubeflow-host>",
"kflow.keycloak.realm": "kubeflow"
```

Optional explicit token endpoint (recommended when Keycloak is on another host):

```json
"kflow.keycloak.tokenUrl": "https://<keycloak-host>/realms/<realm>/protocol/openid-connect/token"
```

> `kflow.keycloak.tokenUrl` must be an **absolute URL** that starts with `http://` or `https://`.

Optional Keycloak client id (default `kubeflow-vscode`):

```json
"kflow.keycloak.clientId": "kubeflow-vscode"
```

Template file location:

```json
"kflow.templatesFile": ".kubeflow/templates.json"
```

---

## Templates (JSON)

Create a workspace file `.kubeflow/templates.json`:

```json
{
  "templates": [
    {
      "name": "GeoTorch",
      "namespace": "kubeflow-user",
      "image": "pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime",
      "gpu": 1,
      "cpu": 2,
      "mem": "16Gi",
      "pip": ["geopandas", "terratorch"],
      "apt": ["libgdal-dev", "libjpeg-dev"],
      "autoPVCforPip": true
    }
  ]
}
```

Then run `Kubeflow: Run Training Job (Template)` with an open Python file.

---

## Live logs

Run `Kubeflow: Stream Job Logs`, select a job, then select a pod. Logs open in the `Kubeflow Logs` output channel.

The extension tags lines that contain `ERROR`, `WARN`, or `Traceback` for quicker scanning.

---

## Login troubleshooting (403 / HTML response)

If you see `Authentication failed (403)` with an HTML page, your token endpoint is likely wrong.

Use one of these configurations:

1. **Realm name only** (same host):

```json
"kflow.url": "https://<kubeflow-host>",
"kflow.keycloak.realm": "kubeflow"
```

2. **Explicit token endpoint** (separate Keycloak host):

```json
"kflow.url": "https://<kubeflow-host>",
"kflow.keycloak.tokenUrl": "https://<keycloak-host>/realms/<realm>/protocol/openid-connect/token"
```

> `kflow.keycloak.tokenUrl` must be an **absolute URL** that starts with `http://` or `https://`.

You can also set `kflow.keycloak.realm` to a full realm URL (`https://.../realms/<realm>`), and the extension auto-appends `/protocol/openid-connect/token`.

If endpoint is correct and credentials are still rejected, verify in Keycloak:
- client ID used by extension (`kflow.keycloak.clientId`, default `kubeflow-vscode`),
- client type/credentials (public client or proper secret handling),
- **Direct Access Grants** enabled for password grant,
- user has no pending required actions (e.g. forced password update).

---

## Current limitations

- Notebook lifecycle and some advanced Kubeflow resources are still iterative.
- Log streaming currently fetches the latest log chunk via API and prints it to output (MVP behavior).
