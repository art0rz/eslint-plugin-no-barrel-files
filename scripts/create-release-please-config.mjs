/**
 * Generates a release-please config file for CI. The base config stays checked
 * in, while temporary maintainer overrides can force an exact version when a
 * release PR carries a supported label such as `release:major`.
 */

import fs from 'node:fs';
import path from 'node:path';

const configPath = path.resolve(process.env.RELEASE_PLEASE_CONFIG_PATH ?? '.github/release-please-config.json');
const manifestPath = path.resolve(process.env.RELEASE_PLEASE_MANIFEST_PATH ?? '.release-please-manifest.json');
const outputPath = path.resolve(
  process.env.RELEASE_PLEASE_OUTPUT_PATH ?? '.github/release-please-config.generated.json',
);
const override = process.env.RELEASE_PLEASE_OVERRIDE ?? '';

const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

if (override === 'release:major') {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const currentVersion = manifest['.'];

  if (typeof currentVersion !== 'string') {
    throw new Error('Expected the root package version to exist in .release-please-manifest.json');
  }

  const [major] = currentVersion.split('.');

  if (!major || Number.isNaN(Number(major))) {
    throw new Error(`Could not parse the current manifest version: ${currentVersion}`);
  }

  const nextMajorVersion = `${Number(major) + 1}.0.0`;

  config.packages ??= {};
  config.packages['.'] ??= {};
  config.packages['.']['release-as'] = nextMajorVersion;
}

fs.writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
