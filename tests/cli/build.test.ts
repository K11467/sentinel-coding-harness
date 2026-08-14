import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, test } from 'vitest';

const repositoryRoot = process.cwd();
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

describe('compiled CLI entrypoint', () => {
  test('build emits a JavaScript bin entry whose offline demo runs without a provider', async () => {
    const build = spawnSync(npm, ['run', 'build'], { cwd: repositoryRoot, encoding: 'utf8' });

    expect(build.status).toBe(0);
    const manifest = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { bin?: Record<string, string> };
    expect(manifest.bin?.sentinel).toBe('dist/cli.js');
    await expect(readFile(join(repositoryRoot, 'dist', 'cli.js'), 'utf8')).resolves.toMatch(/^#!\/usr\/bin\/env node\n/);

    const demo = spawnSync(process.execPath, [join(repositoryRoot, 'dist', 'cli.js'), 'demo'], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    expect(demo.status).toBe(0);
    expect(demo.stdout).toContain('demo-session');
    expect(demo.stderr).toBe('');
  });
});
