import { describe, expect, it } from 'vitest';
import packageJson from '../package.json';
import plugin from './index';

describe('plugin entrypoint', () => {
  it('exposes ESLint 10-compatible metadata and config exports', () => {
    expect(plugin.meta).toEqual({
      name: 'eslint-plugin-no-barrel-files',
      version: packageJson.version,
      namespace: 'no-barrel-files',
    });

    expect(plugin.configs?.recommended).toEqual({
      plugins: ['no-barrel-files'],
      rules: {
        'no-barrel-files/no-barrel-files': 'error',
        'no-barrel-files/prefer-source-imports': 'error',
      },
    });
    expect(plugin.configs?.['flat/recommended']).toEqual([
      {
        plugins: {
          'no-barrel-files': {
            meta: plugin.meta,
            rules: plugin.rules,
          },
        },
        rules: {
          'no-barrel-files/no-barrel-files': 'error',
          'no-barrel-files/prefer-source-imports': 'error',
        },
      },
    ]);
    expect(Object.keys(plugin.configs ?? {})).toEqual(['recommended', 'flat/recommended']);

    expect(plugin.rules).toHaveProperty('prefer-source-imports');
  });
});
