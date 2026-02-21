import * as vscode from 'vscode';

export type KubeflowSettings = {
  url: string;
  verifySSL: boolean;
  realm: string;
  defaultNamespace: string;
  defaultImage: string;
  defaultPVCsize: string;
  autoPVCforPip: boolean;
};

export function getSettings(): KubeflowSettings {
  const cfg = vscode.workspace.getConfiguration();
  return {
    url: cfg.get<string>('kflow.url', ''),
    verifySSL: cfg.get<boolean>('kflow.verifySSL', true),
    realm: cfg.get<string>('kflow.keycloak.realm', ''),
    defaultNamespace: cfg.get<string>('kflow.defaultNamespace', 'kubeflow-user'),
    defaultImage: cfg.get<string>('kflow.defaultImage', 'pytorch/pytorch:2.1.0-cuda12.1-cudnn8-runtime'),
    defaultPVCsize: cfg.get<string>('kflow.defaultPVCsize', '10Gi'),
    autoPVCforPip: cfg.get<boolean>('kflow.autoPVCforPip', true)
  };
}
