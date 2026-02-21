import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class ArtifactPackager {
  async packageToTarGz(sourceFileOrDir: string): Promise<string> {
    const absSource = path.resolve(sourceFileOrDir);
    const stat = await fs.stat(absSource);
    const sourceDir = stat.isDirectory() ? absSource : path.dirname(absSource);
    const tempTar = path.join(sourceDir, `.kflow-artifact-${Date.now()}.tar.gz`);

    await execFileAsync('tar', ['-czf', tempTar, '-C', sourceDir, '.']);
    return tempTar;
  }

  async readBase64(archivePath: string): Promise<string> {
    const bytes = await fs.readFile(archivePath);
    return bytes.toString('base64');
  }
}
