# Kubeflow Training VS Code Plugin (MVP scaffold)

This repository now contains a working MVP scaffold of a VS Code extension that implements the core Kubeflow workflow:

- interactive login command
- secret storage for tokens
- auto-refresh session timer
- run active Python file as Kubeflow PyTorchJob
- code packaging as `tar.gz` and upload into ConfigMap
- optional auto-create `pip-cache-pvc`
- submit manifest through Kubernetes REST API
- Kubeflow explorer panel with top-level sections and Jobs listing

## Development

```bash
npm install
npm run compile
```

Then run the extension in VS Code using `F5` in Extension Development Host.
