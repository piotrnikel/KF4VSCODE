import * as vscode from 'vscode';
import { getSettings } from '../utils/settings';

type Session = {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
};

const ACCESS_TOKEN_KEY = 'kflow.accessToken';
const REFRESH_TOKEN_KEY = 'kflow.refreshToken';
const EXPIRES_AT_KEY = 'kflow.expiresAt';

export class AuthService implements vscode.Disposable {
  private session?: Session;
  private refreshTimer?: NodeJS.Timeout;

  constructor(private readonly secrets: vscode.SecretStorage) {}

  async initialize(): Promise<void> {
    const accessToken = await this.secrets.get(ACCESS_TOKEN_KEY);
    if (!accessToken) return;
    const refreshToken = await this.secrets.get(REFRESH_TOKEN_KEY);
    const expiresRaw = await this.secrets.get(EXPIRES_AT_KEY);
    const expiresAt = expiresRaw ? Number(expiresRaw) : Date.now();
    this.session = { accessToken, refreshToken: refreshToken ?? undefined, expiresAt };
    this.scheduleRefresh();
  }

  async loginInteractive(): Promise<void> {
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
      const body = await res.text();
      throw new Error(`Authentication failed (${res.status}): ${body}`);
    }

    const payload = (await res.json()) as Record<string, string | number>;
    await this.setSession({
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
      expiresAt: Date.now() + Number(payload.expires_in ?? 300) * 1000
    });
  }

  getAccessToken(): string | undefined {
    return this.session?.accessToken;
  }

  async ensureValidSession(): Promise<void> {
    if (!this.session) {
      throw new Error('Not logged in. Run "Kubeflow: Login" first.');
    }
    if (Date.now() + 5 * 60 * 1000 < this.session.expiresAt) return;
    await this.refreshSession();
  }

  async signOut(): Promise<void> {
    this.session = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    await Promise.all([
      this.secrets.delete(ACCESS_TOKEN_KEY),
      this.secrets.delete(REFRESH_TOKEN_KEY),
      this.secrets.delete(EXPIRES_AT_KEY)
    ]);
  }

  private async refreshSession(): Promise<void> {
    if (!this.session?.refreshToken) {
      throw new Error('Session expired and no refresh token is available.');
    }
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
    const payload = (await res.json()) as Record<string, string | number>;
    await this.setSession({
      accessToken: String(payload.access_token),
      refreshToken: payload.refresh_token ? String(payload.refresh_token) : this.session.refreshToken,
      expiresAt: Date.now() + Number(payload.expires_in ?? 300) * 1000
    });
  }

  private async setSession(session: Session): Promise<void> {
    this.session = session;
    await this.secrets.store(ACCESS_TOKEN_KEY, session.accessToken);
    if (session.refreshToken) await this.secrets.store(REFRESH_TOKEN_KEY, session.refreshToken);
    await this.secrets.store(EXPIRES_AT_KEY, String(session.expiresAt));
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (!this.session) return;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const delayMs = Math.max(10_000, this.session.expiresAt - Date.now() - 5 * 60 * 1000);
    this.refreshTimer = setTimeout(() => {
      this.refreshSession().catch(async (err) => {
        vscode.window.showWarningMessage(`Kubeflow session refresh failed: ${String(err)}`);
        await this.signOut();
      });
    }, delayMs);
  }

  private resolveTokenEndpoint(url: string, realm: string): string {
    const base = url.replace(/\/$/, '');
    const r = realm || 'kubeflow';
    return `${base}/realms/${r}/protocol/openid-connect/token`;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }
}
