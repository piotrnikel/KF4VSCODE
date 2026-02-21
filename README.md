# Kubeflow Training VS Code Extension (drop-in runtime build)

This extension is now packaged to run **without any TypeScript build step**.

## What you need to do

1. Copy this folder into your VS Code extensions directory:
   - Linux/macOS: `~/.vscode/extensions/kubeflow-vscode-plugin`
   - Windows: `%USERPROFILE%\\.vscode\\extensions\\kubeflow-vscode-plugin`
2. Restart VS Code.
3. Open Command Palette and run `Kubeflow: Login`.

No `npm install` and no `npm run compile` are required for runtime.

## Included features

- Kubeflow sidebar (`KUBEFLOW PANEL`)
- `Kubeflow: Login` / `Sign out`
- Run active `.py` file as a Kubeflow `PyTorchJob`
- Internal artifact packaging as `tar.gz`
- ConfigMap artifact upload and optional auto-create `pip-cache-pvc`
- Submit manifest via Kubernetes REST API
- View generated manifest command

## Notes

- The current auth implementation targets a Keycloak token endpoint (`/realms/<realm>/protocol/openid-connect/token`).
- Some commands are scaffolded placeholders for next iterations (`Create Notebook`, `Delete Training Job`, `Describe Job`, `Restart Job`).
