import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

describe('CI 配置', () => {
  test('GitHub Actions 只运行离线质量门禁', () => {
    const workflow = read('.github/workflows/ci.yml');
    expect(workflow).toContain('npm ci');
    expect(workflow).toContain('npm run check');
    expect(workflow).not.toMatch(/credentials\s+set|\/v1\/responses|API[_-]?KEY/i);
  });

  test('GitLab unit-test job 与本地质量门禁一致', () => {
    const config = read('.gitlab-ci.yml');
    expect(config).toContain('unit-test');
    expect(config).toContain('npm ci');
    expect(config).toContain('npm run check');
  });
});
