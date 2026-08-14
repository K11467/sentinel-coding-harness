import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const packageRoot = resolve(fileURLToPath(new URL('../', import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const requiredFiles = [
  'dist/cli.js',
  'package.json',
  'README.md',
  'LICENSE',
  'DEMO_GUIDE.md',
  'REFERENCES.md',
  'SPEC.md',
  'THREAT_MODEL.md',
  'examples/harness.yaml'
];
const documentationFiles = new Set(requiredFiles.filter((path) => path.endsWith('.md')));

function runNpm(args) {
  try {
    return execFileSync(npm, args, {
      cwd: packageRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        npm_config_offline: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch {
    throw new Error(`离线 npm ${args.join(' ')} 未成功完成。`);
  }
}

function isForbidden(path) {
  return path === 'node_modules'
    || path.startsWith('node_modules/')
    || path === '.sentinel'
    || path.startsWith('.sentinel/')
    || path === 'data'
    || path.startsWith('data/')
    || path.startsWith('.env')
    || /(?:^|\/)\S+\.(?:key|pem|p12|log)$/i.test(path);
}

function isAllowed(path) {
  return path === 'package.json'
    || path === 'LICENSE'
    || documentationFiles.has(path)
    || path.startsWith('dist/')
    || path.startsWith('examples/');
}

function parseManifest(json) {
  let packed;
  try {
    packed = JSON.parse(json);
  } catch {
    throw new Error('npm pack 未返回 JSON 清单。');
  }
  if (!Array.isArray(packed) || packed.length !== 1 || packed[0] === null || typeof packed[0] !== 'object') {
    throw new Error('npm pack JSON 清单格式无效。');
  }

  const manifest = packed[0];
  if (typeof manifest.id !== 'string' || !Array.isArray(manifest.files)) {
    throw new Error('npm pack JSON 缺少包标识或文件清单。');
  }
  const files = manifest.files.map((file) => file?.path);
  if (files.some((path) => typeof path !== 'string' || path.length === 0)) {
    throw new Error('npm pack JSON 含无效文件路径。');
  }
  return { id: manifest.id, files: [...files].sort() };
}

function validateManifest(manifest) {
  const missing = requiredFiles.filter((path) => !manifest.files.includes(path));
  if (missing.length > 0) {
    throw new Error(`发布包缺少必需文件：${missing.join(', ')}。`);
  }
  const forbidden = manifest.files.filter(isForbidden);
  if (forbidden.length > 0) {
    throw new Error(`发布包包含受限文件：${forbidden.join(', ')}。`);
  }
  const unexpected = manifest.files.filter((path) => !isAllowed(path));
  if (unexpected.length > 0) {
    throw new Error(`发布包包含白名单外文件：${unexpected.join(', ')}。`);
  }
  return { ok: true, package: manifest.id, files: manifest.files };
}

function main() {
  runNpm(['--offline', 'run', 'build']);
  const output = runNpm(['--offline', 'pack', '--dry-run', '--json', '--ignore-scripts']);
  return validateManifest(parseManifest(output));
}

try {
  process.stdout.write(`${JSON.stringify(main())}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : '发布预检失败。';
  process.stderr.write(`发布预检失败：${message}\n`);
  process.exitCode = 1;
}
