/**
 * Stamps a unique canary version onto package metadata in CI without creating
 * a git tag or commit. The canary build stays traceable to the workflow run
 * and commit that produced it while leaving the checked-in stable version
 * untouched on the branch.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const packageJsonPath = path.resolve('package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

const baseVersion = packageJson.version;
const runNumber = process.env.GITHUB_RUN_NUMBER ?? `${Date.now()}`;
const runAttempt = process.env.GITHUB_RUN_ATTEMPT ?? '1';
const shortSha = (process.env.GITHUB_SHA ?? 'local').slice(0, 7).toLowerCase();
const canaryVersion = `${baseVersion}-canary.${runNumber}.${runAttempt}.${shortSha}`;

execFileSync('npm', ['version', canaryVersion, '--no-git-tag-version', '--allow-same-version'], {
  stdio: 'inherit',
});

process.stdout.write(`${canaryVersion}\n`);
