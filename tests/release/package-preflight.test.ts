import { afterEach, describe, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = resolve(__dirname, '../..');
const fixtureFiles = [
  '.env.t17-fixture',
  't17-fixture.pem',
  't17-fixture.key',
  't17-fixture.log',
  '.sentinel/t17-fixture-state.json',
  'data/t17-fixture-state.json'
];
const fixtureDirectories = ['.sentinel', 'data'];
const createdFixtureDirectories: string[] = [];
const prepackFailureFile = 'tests/t17-prepack-failure.test.ts';
const testIfPackPrecheckIsNotAlreadyRunning = process.env.SENTINEL_T17_PREPACK_ASSERT === '1' ? test.skip : test;

afterEach(async () => {
  await Promise.all(fixtureFiles.map((file) => rm(join(repositoryRoot, file), { force: true })));
  await rm(join(repositoryRoot, prepackFailureFile), { force: true });
  await Promise.all(createdFixtureDirectories.splice(0).map((directory) => rm(join(repositoryRoot, directory), { force: true, recursive: true })));
});

describe('release package preflight', () => {
  test('builds offline and emits a strict dry-run manifest without local runtime or credential fixtures', async () => {
    await Promise.all(fixtureDirectories.map(ensureFixtureDirectory));
    await Promise.all(fixtureFiles.map((file) => writeFile(join(repositoryRoot, file), 'fixture only', 'utf8')));

    const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/release-preflight.mjs'], {
      cwd: repositoryRoot,
      env: { ...process.env, npm_config_offline: 'true' }
    });
    const report = JSON.parse(stdout) as { ok: boolean; package: string; files: string[] };

    expect(stderr).toBe('');
    expect(report.ok).toBe(true);
    expect(report.package).toBe('sentinel-coding-harness@0.1.0');
    expect(report.files).toContain('dist/cli.js');
    expect(report.files).toContain('README.md');
    expect(report.files).toContain('LICENSE');
    expect(report.files).toContain('DEMO_GUIDE.md');
    expect(report.files).toContain('REFERENCES.md');
    expect(report.files).toContain('SPEC.md');
    expect(report.files).toContain('THREAT_MODEL.md');
    expect(report.files).toContain('examples/harness.yaml');
    expect(report.files).not.toContain('src/cli.ts');
    expect(report.files).not.toContain('tests/release/package-preflight.test.ts');
    expect(report.files.some((path) => isForbidden(path))).toBe(false);
    expect(report.files.every((path) => isReleaseFile(path))).toBe(true);
  });

  testIfPackPrecheckIsNotAlreadyRunning('runs offline check before build when npm pack invokes prepack', async () => {
    await writeFile(join(repositoryRoot, prepackFailureFile), [
      "import { test } from 'vitest';",
      "test('T17 prepack check fixture', () => { throw new Error('T17_PREPACK_CHECK_FAILURE'); });"
    ].join('\n'), 'utf8');

    let packFailure: unknown;
    try {
      await execFileAsync('npm', ['--offline', 'pack', '--dry-run', '--json'], {
        cwd: repositoryRoot,
        env: { ...process.env, SENTINEL_T17_PREPACK_ASSERT: '1', npm_config_offline: 'true' }
      });
    } catch (error) {
      packFailure = error;
    }

    expect(packFailure).toBeDefined();
    expect(commandOutput(packFailure)).toContain('T17_PREPACK_CHECK_FAILURE');
    const packageJson = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8')) as { scripts: { prepack: string } };
    expect(packageJson.scripts.prepack).toBe('npm_config_offline=true npm run check && npm_config_offline=true npm run build');
  });
});

async function ensureFixtureDirectory(directory: string): Promise<void> {
  try {
    await stat(join(repositoryRoot, directory));
  } catch {
    await mkdir(join(repositoryRoot, directory));
    createdFixtureDirectories.push(directory);
  }
}

function commandOutput(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const result = error as { stdout?: unknown; stderr?: unknown };
    return `${typeof result.stdout === 'string' ? result.stdout : ''}\n${typeof result.stderr === 'string' ? result.stderr : ''}`;
  }
  return '';
}

function isForbidden(path: string): boolean {
  return path === 'node_modules'
    || path.startsWith('node_modules/')
    || path === '.sentinel'
    || path.startsWith('.sentinel/')
    || path === 'data'
    || path.startsWith('data/')
    || path.startsWith('.env')
    || /(?:^|\/)\S+\.(?:key|pem|p12|log)$/i.test(path);
}

function isReleaseFile(path: string): boolean {
  return path === 'package.json'
    || path === 'README.md'
    || path === 'LICENSE'
    || path === 'DEMO_GUIDE.md'
    || path === 'REFERENCES.md'
    || path === 'SPEC.md'
    || path === 'THREAT_MODEL.md'
    || path.startsWith('dist/')
    || path.startsWith('examples/');
}
