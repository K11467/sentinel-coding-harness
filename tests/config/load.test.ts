import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadHarnessConfig } from '../../src/config/load.js';

const temporaryDirectories: string[] = [];

async function workspace(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-config-'));
  temporaryDirectories.push(directory);
  return realpath(directory);
}

async function yaml(cwd: string, content: string, name = 'harness.yaml'): Promise<string> {
  const path = join(cwd, name);
  await writeFile(path, content, 'utf8');
  return path;
}

async function load(content: string): Promise<ReturnType<typeof loadHarnessConfig>> {
  const cwd = await workspace();
  await yaml(cwd, content);
  return loadHarnessConfig({ cwd });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('loadHarnessConfig', () => {
  test('applies explicit safe defaults and resolves an omitted workspaceRoot from the caller cwd', async () => {
    const cwd = await workspace();
    await yaml(cwd, 'testCommand:\n  command: npm\n  args: [test]\n');

    expect(loadHarnessConfig({ cwd })).toEqual({
      workspaceRoot: cwd,
      model: 'gpt-5.4-mini',
      maxSteps: 6,
      maxCostCny: 70,
      allowedCommands: [],
      policyRules: [],
      testCommand: { command: 'npm', args: ['test'] }
    });
  });

  test('uses the caller cwd, rather than the yaml location, to resolve workspaceRoot', async () => {
    const cwd = await workspace();
    const project = await workspace();
    const configPath = await yaml(project, 'workspaceRoot: .\ntestCommand: { command: npm, args: [test] }\n');

    expect(loadHarnessConfig({ cwd, configPath })).toMatchObject({ workspaceRoot: cwd });
  });

  test.each([
    ['unknown top-level field', 'testCommand: { command: npm, args: [test] }\nunexpected: true\n'],
    ['unknown nested test-command field', 'testCommand: { command: npm, args: [test], shell: true }\n'],
    ['unknown nested policy-match field', 'testCommand: { command: npm, args: [test] }\npolicyRules:\n  - id: review\n    effect: deny\n    risk: high\n    match: { unknown: value }\n']
  ])('rejects %s instead of ignoring it', async (_name, content) => {
    await expect(load(content)).rejects.toThrow(/配置无效|未知字段/);
  });

  test('rejects malformed YAML with an explicit diagnostic', async () => {
    await expect(load('testCommand: [\n')).rejects.toThrow(/YAML/);
  });

  test.each([
    ['maxSteps above 12', 'maxSteps: 13'],
    ['maxCostCny above 70', 'maxCostCny: 70.01'],
    ['non-integral maxSteps', 'maxSteps: 1.5']
  ])('rejects invalid numeric limit: %s', async (_name, line) => {
    await expect(load(`${line}\ntestCommand: { command: npm, args: [test] }\n`)).rejects.toThrow(/配置无效/);
  });

  test.each([
    ['empty allow match', 'policyRules:\n  - id: allow-all\n    effect: allow\n    risk: low\n    match: {}\n'],
    ['network command allow rule', 'policyRules:\n  - id: allow-curl\n    effect: allow\n    risk: low\n    match: { commands: [curl] }\n'],
    ['generic npm allow rule', 'policyRules:\n  - id: allow-npm\n    effect: allow\n    risk: low\n    match: { commands: [npm] }\n'],
    ['rm allowlist entry', 'allowedCommands:\n  - command: rm\n    argsPrefix: []\n'],
    ['git allowlist entry', 'allowedCommands:\n  - command: git\n    argsPrefix: [status]\n'],
    ['npm install allowlist entry', 'allowedCommands:\n  - command: npm\n    argsPrefix: [install]\n']
  ])('rejects dangerous allow configuration: %s', async (_name, extra) => {
    await expect(load(`testCommand: { command: npm, args: [test] }\n${extra}`)).rejects.toThrow(/危险|allow|策略/);
  });

  test.each([
    ['missing testCommand', 'model: local\n'],
    ['extra test-command field', 'testCommand: { command: npm, args: [test], fromModel: true }\n'],
    ['shell-looking command', 'testCommand: { command: "npm test", args: [] }\n'],
    ['shell-control argument', 'testCommand: { command: npm, args: ["test; rm -rf /"] }\n']
  ])('rejects invalid trusted testCommand: %s', async (_name, content) => {
    await expect(load(content)).rejects.toThrow(/testCommand|配置无效/);
  });

  const interpreterPayloads = [
    { name: 'sh -c', command: 'sh', args: ['-c', 'echo unsafe'] },
    { name: 'bash -c', command: 'bash', args: ['-c', 'echo unsafe'] },
    { name: 'node -e', command: 'node', args: ['-e', '1'] },
    { name: 'env sh -c wrapper', command: 'env', args: ['sh', '-c', 'echo unsafe'] }
  ];

  test.each(interpreterPayloads)('rejects interpreter payload from testCommand without creating executable config: $name', async ({ command, args }) => {
    const cwd = await workspace();
    await yaml(cwd, `testCommand: { command: ${command}, args: [${args.map(JSON.stringify).join(', ')}] }\n`);

    expect(() => loadHarnessConfig({ cwd })).toThrow(/testCommand|危险|配置无效/);
  });

  test.each(interpreterPayloads)('rejects interpreter payload from allowedCommands without creating executable config: $name', async ({ command, args }) => {
    const cwd = await workspace();
    await yaml(cwd, [
      'testCommand: { command: npm, args: [test] }',
      'allowedCommands:',
      `  - command: ${command}`,
      `    argsPrefix: [${args.map(JSON.stringify).join(', ')}]`
    ].join('\n'));

    expect(() => loadHarnessConfig({ cwd })).toThrow(/allow|危险|配置无效/);
  });

  test.each(interpreterPayloads)('rejects interpreter executable from allow policy without creating executable config: $name', async ({ command }) => {
    const cwd = await workspace();
    await yaml(cwd, [
      'testCommand: { command: npm, args: [test] }',
      'policyRules:',
      '  - id: unsafe-interpreter',
      '    effect: allow',
      '    risk: low',
      `    match: { commands: [${command}] }`
    ].join('\n'));

    expect(() => loadHarnessConfig({ cwd })).toThrow(/allow|危险|配置无效/);
  });

  test.each(['-c', '-e', '--eval'])('rejects interpreter semantic argument from testCommand: %s', async (argument) => {
    const cwd = await workspace();
    await yaml(cwd, `testCommand: { command: npm, args: [test, ${JSON.stringify(argument)}] }\n`);

    expect(() => loadHarnessConfig({ cwd })).toThrow(/testCommand|配置无效/);
  });

  test.each(['-c', '-e', '--eval'])('rejects interpreter semantic argument from allowedCommands: %s', async (argument) => {
    const cwd = await workspace();
    await yaml(cwd, [
      'testCommand: { command: npm, args: [test] }',
      'allowedCommands:',
      '  - command: eslint',
      `    argsPrefix: [${JSON.stringify(argument)}]`
    ].join('\n'));

    expect(() => loadHarnessConfig({ cwd })).toThrow(/allow|危险|配置无效/);
  });

  test('loads the committed example without allowing model-provided test commands', async () => {
    expect(loadHarnessConfig({
      cwd: process.cwd(),
      configPath: join(process.cwd(), 'examples', 'harness.yaml')
    })).toMatchObject({
      testCommand: { command: 'npm', args: ['test'] }
    });
  });
});
