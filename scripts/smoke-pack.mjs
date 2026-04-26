import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import Module, { createRequire } from 'node:module';

// Verifies the publishable tarball end-to-end:
// - builds the package before packing
// - ensures expected runtime files are present
// - ensures the tarball only contains approved publish paths
// - ensures test artifacts are not shipped
// - loads the extracted plugin entrypoint successfully
const repoRoot = process.cwd();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pack-smoke-'));
const npmCacheDir = path.join(tempRoot, 'npm-cache');
process.env.NODE_PATH = path.join(repoRoot, 'node_modules');
Module._initPaths();
const env = {
  ...process.env,
  npm_config_cache: npmCacheDir,
};

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} ${args.join(' ')} failed`);
  }

  return result.stdout;
}

try {
  fs.mkdirSync(tempRoot, { recursive: true });
  run('npm', ['pack', '--pack-destination', tempRoot]);

  const tarballName = fs.readdirSync(tempRoot).find(fileName => fileName.endsWith('.tgz'));
  assert.ok(tarballName, 'npm pack did not produce a tarball');

  const tarballPath = path.join(tempRoot, tarballName);
  const packagedFiles = run('tar', ['-tzf', tarballPath])
    .split('\n')
    .filter(Boolean)
    .map(filePath => filePath.replace(/^\.?\/?package\//, ''));
  const allowedPublishPaths = [/^LICENSE$/, /^README\.md$/, /^package\.json$/, /^dist\/.+$/];
  const unexpectedPublishPaths = packagedFiles.filter(
    filePath => !allowedPublishPaths.some(pattern => pattern.test(filePath)),
  );
  const unexpectedFiles = packagedFiles.filter(filePath => filePath.startsWith('dist/rules/tests/'));

  assert.ok(packagedFiles.includes('dist/index.js'), 'packed tarball is missing dist/index.js');
  assert.ok(packagedFiles.includes('package.json'), 'packed tarball is missing package.json');
  assert.equal(
    unexpectedPublishPaths.length,
    0,
    `packed tarball contains unexpected files:\n${unexpectedPublishPaths.join('\n')}`,
  );
  assert.equal(
    unexpectedFiles.length,
    0,
    `packed tarball should not contain compiled test artifacts:\n${unexpectedFiles.join('\n')}`,
  );

  const unpackDir = path.join(tempRoot, 'unpacked');
  fs.mkdirSync(unpackDir, { recursive: true });
  run('tar', ['-xzf', tarballPath, '-C', unpackDir], repoRoot);

  const extractedPackageDir = path.join(unpackDir, 'package');
  const packageRequire = createRequire(path.join(extractedPackageDir, 'package.json'));
  const plugin = packageRequire('./');

  assert.ok(plugin.rules['no-barrel-files'], 'packed plugin is missing no-barrel-files');
  assert.ok(plugin.configs?.recommended, 'packed plugin is missing recommended config');
} finally {
  fs.rmSync(tempRoot, { force: true, recursive: true });
}
