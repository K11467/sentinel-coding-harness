import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { WorkspaceTools } from '../../src/tools/workspace.js';

const temporaryPaths: string[] = [];

async function createWorkspace(): Promise<{ root: string; outside: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'sentinel-workspace-'));
  temporaryPaths.push(parent);
  const root = join(parent, 'workspace');
  const outside = join(parent, 'outside');
  await Promise.all([mkdir(root), mkdir(outside)]);
  return { root, outside };
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe('WorkspaceTools', () => {
  test('在工作区内受控列出、读取和写入文本文件', async () => {
    const { root } = await createWorkspace();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'existing.txt'), 'before', 'utf8');
    const tools = new WorkspaceTools(root);

    await expect(tools.list('src')).resolves.toEqual({
      ok: true,
      kind: 'list',
      path: 'src',
      entries: ['existing.txt']
    });
    await expect(tools.read('src/existing.txt')).resolves.toEqual({
      ok: true,
      kind: 'read',
      path: 'src/existing.txt',
      content: 'before'
    });
    await expect(tools.write('src/new.txt', 'after')).resolves.toEqual({
      ok: true,
      kind: 'write',
      path: 'src/new.txt',
      bytesWritten: 5
    });
    await expect(tools.read('src/new.txt')).resolves.toMatchObject({ ok: true, content: 'after' });
  });

  test.each([
    ['../outside.txt'],
    ['/tmp/outside.txt']
  ])('拒绝 %s 的读写与列目录路径', async (path) => {
    const { root } = await createWorkspace();
    const tools = new WorkspaceTools(root);

    await expect(tools.list(path)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_path' });
    await expect(tools.read(path)).resolves.toMatchObject({ ok: false, errorCode: 'invalid_path' });
    await expect(tools.write(path, 'blocked')).resolves.toMatchObject({ ok: false, errorCode: 'invalid_path' });
  });

  test('拒绝读取指向工作区外的符号链接', async () => {
    const { root, outside } = await createWorkspace();
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'));
    const tools = new WorkspaceTools(root);

    await expect(tools.read('escape.txt')).resolves.toMatchObject({ ok: false, errorCode: 'symlink_escape' });
  });

  test('拒绝经由预存的工作区外符号链接写入', async () => {
    const { root, outside } = await createWorkspace();
    const externalTarget = join(outside, 'target.txt');
    await writeFile(externalTarget, 'original', 'utf8');
    await symlink(externalTarget, join(root, 'escape.txt'));
    const tools = new WorkspaceTools(root);

    await expect(tools.write('escape.txt', 'blocked')).resolves.toMatchObject({ ok: false, errorCode: 'symlink_escape' });
    await expect(tools.read('escape.txt')).resolves.toMatchObject({ ok: false, errorCode: 'symlink_escape' });
  });

  test('列目录不跟随指向工作区外的符号链接', async () => {
    const { root, outside } = await createWorkspace();
    await writeFile(join(outside, 'secret.txt'), 'secret', 'utf8');
    await symlink(outside, join(root, 'escape-dir'));
    const tools = new WorkspaceTools(root);

    await expect(tools.list('escape-dir')).resolves.toMatchObject({ ok: false, errorCode: 'symlink_escape' });
    await expect(tools.list()).resolves.toEqual({
      ok: true,
      kind: 'list',
      path: '.',
      entries: ['escape-dir']
    });
  });

  test('拒绝读取二进制、含 NUL 或超过 256 KiB 的文件', async () => {
    const { root } = await createWorkspace();
    await writeFile(join(root, 'binary.bin'), Buffer.from([0x61, 0x00, 0x62]));
    await writeFile(join(root, 'large.txt'), 'a'.repeat(256 * 1024 + 1), 'utf8');
    const tools = new WorkspaceTools(root);

    await expect(tools.read('binary.bin')).resolves.toMatchObject({ ok: false, errorCode: 'binary_file' });
    await expect(tools.read('large.txt')).resolves.toMatchObject({ ok: false, errorCode: 'file_too_large' });
  });

  test('拒绝超过 256 KiB 的写入内容', async () => {
    const { root } = await createWorkspace();
    const tools = new WorkspaceTools(root);

    await expect(tools.write('large.txt', 'a'.repeat(256 * 1024 + 1))).resolves.toMatchObject({
      ok: false,
      errorCode: 'file_too_large'
    });
  });
});
