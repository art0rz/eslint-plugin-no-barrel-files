import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

// Verifies the packed plugin can be consumed by a downstream project:
// - packs the current workspace artifact
// - installs that artifact into a throwaway consumer layout
// - exercises either flat or legacy ESLint config wiring
// - asserts the packaged rule reports a known barrel-file violation
const repoRoot = process.cwd();
const consumerConfig = process.env.CONSUMER_CONFIG ?? 'flat';
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'consumer-smoke-'));
const npmCacheDir = path.join(tempRoot, 'npm-cache');
const env = {
  ...process.env,
  NODE_PATH: path.join(repoRoot, 'node_modules'),
  npm_config_cache: npmCacheDir,
};

function run(command, args, cwd = repoRoot, allowedStatuses = [0], envOverrides = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env: {
      ...env,
      ...envOverrides,
    },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (!allowedStatuses.includes(result.status ?? 1)) {
    throw new Error([result.stderr, result.stdout, `${command} ${args.join(' ')} failed`].filter(Boolean).join('\n\n'));
  }

  return result.stdout;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

try {
  fs.mkdirSync(tempRoot, { recursive: true });
  run('npm', ['pack', '--pack-destination', tempRoot]);

  const tarballName = fs.readdirSync(tempRoot).find(fileName => fileName.endsWith('.tgz'));
  assert.ok(tarballName, 'npm pack did not produce a tarball for consumer smoke test');

  const tarballPath = path.join(tempRoot, tarballName);
  const projectDir = path.join(tempRoot, 'project');
  const pluginDir = path.join(projectDir, 'node_modules', 'eslint-plugin-no-barrel-files');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });

  writeJson(path.join(projectDir, 'package.json'), {
    name: 'consumer-smoke',
    private: true,
    type: 'module',
  });

  fs.writeFileSync(path.join(projectDir, 'foo.js'), 'export const Foo = "foo";\n');
  fs.writeFileSync(path.join(projectDir, 'index.js'), 'export * from "./foo.js";\n');

  if (consumerConfig === 'flat') {
    fs.writeFileSync(
      path.join(projectDir, 'eslint.config.mjs'),
      [
        "import plugin from 'eslint-plugin-no-barrel-files';",
        '',
        'export default [',
        "  ...plugin.configs['flat/recommended'],",
        '];',
        '',
      ].join('\n'),
    );
  } else {
    writeJson(path.join(projectDir, 'package.json'), {
      name: 'consumer-smoke',
      private: true,
    });
    fs.writeFileSync(
      path.join(projectDir, '.eslintrc.cjs'),
      [
        'module.exports = {',
        '  parserOptions: {',
        "    ecmaVersion: 'latest',",
        "    sourceType: 'module',",
        '  },',
        "  plugins: ['no-barrel-files'],",
        '  rules: {',
        "    'no-barrel-files/no-barrel-files': 'error',",
        '  },',
        '};',
        '',
      ].join('\n'),
    );
  }

  run('tar', ['-xzf', tarballPath, '-C', pluginDir, '--strip-components=1']);

  const eslintBin = path.join(repoRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint');
  const outputFile = path.join(projectDir, 'eslint-output.json');
  const args = ['index.js', '--format', 'json', '--output-file', outputFile];
  const eslintEnv = consumerConfig === 'legacy' ? { ESLINT_USE_FLAT_CONFIG: 'false' } : {};

  if (consumerConfig === 'legacy') {
    args.unshift('--config', '.eslintrc.cjs');
  }

  run(eslintBin, args, projectDir, [0, 1], eslintEnv);
  const [result] = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  const ruleMessage = result?.messages.find(message => message.ruleId === 'no-barrel-files/no-barrel-files');

  assert.ok(result, 'eslint did not return a lint result');
  assert.equal(result.errorCount, 1, `expected one lint error, received ${result.errorCount}`);
  assert.ok(ruleMessage, 'expected packaged plugin to report no-barrel-files/no-barrel-files');
} finally {
  fs.rmSync(tempRoot, { force: true, recursive: true });
}
