import { AuthService } from '../auth/authService';
import { getSettings } from '../utils/settings';

export class K8sApiClient {
  constructor(private readonly authService: AuthService) {}

  async createCustomObject(group: string, version: string, namespace: string, plural: string, body: unknown): Promise<unknown> {
    return this.request(`/apis/${group}/${version}/namespaces/${namespace}/${plural}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async createCoreObject(namespace: string, plural: string, body: unknown): Promise<unknown> {
    return this.request(`/api/v1/namespaces/${namespace}/${plural}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
  }

  async list(namespace: string, path: string): Promise<unknown> {
    return this.request(`${path.replace('{namespace}', namespace)}`);
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    await this.authService.ensureValidSession();
    const settings = getSettings();
    const token = this.authService.getAccessToken();
    const url = `${settings.url.replace(/\/$/, '')}${path}`;
    const res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {})
      }
    });

    if (!res.ok) {
      throw new Error(`Kubernetes API error ${res.status}: ${await res.text()}`);
    }

    return res.status === 204 ? {} : res.json();
  }
}
