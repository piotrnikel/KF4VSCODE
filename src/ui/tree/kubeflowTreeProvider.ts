import * as vscode from 'vscode';
import { K8sApiClient } from '../../kube/k8sApiClient';

class Item extends vscode.TreeItem {
  constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, public readonly path?: string) {
    super(label, collapsibleState);
    this.contextValue = 'kubeflowItem';
  }
}

export class KubeflowTreeProvider implements vscode.TreeDataProvider<Item> {
  private readonly onDidChangeTreeDataEmitter = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.onDidChangeTreeDataEmitter.event;

  constructor(private readonly k8sClient: K8sApiClient) {}

  refresh(): void {
    this.onDidChangeTreeDataEmitter.fire(undefined);
  }

  getTreeItem(element: Item): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: Item): Promise<Item[]> {
    if (!element) {
      return ['Jobs', 'Notebooks', 'PVC', 'ConfigMaps', 'Pipelines', 'Model Registry'].map(
        (n) => new Item(n, vscode.TreeItemCollapsibleState.Collapsed, n)
      );
    }

    const namespace = vscode.workspace.getConfiguration().get<string>('kflow.defaultNamespace', 'kubeflow-user');
    try {
      if (element.path === 'Jobs') {
        const jobs = (await this.k8sClient.list(namespace, '/apis/kubeflow.org/v1/namespaces/{namespace}/pytorchjobs')) as {
          items?: Array<{ metadata?: { name?: string } }>;
        };
        return (jobs.items ?? []).map((j) => new Item(j.metadata?.name ?? 'unnamed', vscode.TreeItemCollapsibleState.None));
      }
    } catch {
      return [new Item('Login required or API unavailable', vscode.TreeItemCollapsibleState.None)];
    }

    return [new Item('Not implemented yet', vscode.TreeItemCollapsibleState.None)];
  }
}
