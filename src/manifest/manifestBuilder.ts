export type JobOptions = {
  name: string;
  namespace: string;
  image: string;
  gpu: number;
  cpu: string;
  memory: string;
  scriptPath: string;
  pip: string[];
  apt: string[];
  autoPVCforPip: boolean;
};

export class ManifestBuilder {
  buildPVC(name: string, namespace: string, size: string): Record<string, unknown> {
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

  buildPyTorchJob(options: JobOptions, artifactConfigMapName: string): Record<string, unknown> {
    const aptInstall = options.apt.length > 0 ? `apt-get update && apt-get install -y ${options.apt.join(' ')} && ` : '';
    const pipInstall = options.pip.length > 0 ? `pip install ${options.pip.join(' ')} && ` : '';

    const command = `${aptInstall}${pipInstall}python ${options.scriptPath}`;

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
                    command: ['/bin/sh', '-c', command],
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
                  {
                    name: 'job-code',
                    configMap: { name: artifactConfigMapName }
                  },
                  ...(options.autoPVCforPip
                    ? [
                        {
                          name: 'pip-cache',
                          persistentVolumeClaim: { claimName: 'pip-cache-pvc' }
                        }
                      ]
                    : [])
                ]
              }
            }
          }
        }
      }
    };
  }

  buildArtifactConfigMap(namespace: string, name: string, encodedTarGz: string): Record<string, unknown> {
    return {
      apiVersion: 'v1',
      kind: 'ConfigMap',
      metadata: { name, namespace },
      data: {
        'artifact.tar.gz.base64': encodedTarGz
      }
    };
  }
}
