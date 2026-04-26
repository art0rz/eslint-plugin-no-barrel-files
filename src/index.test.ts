import { describe, expect, it } from 'vitest';
import plugin from './index';

describe('plugin entrypoint', () => {
  it('exposes ESLint 10-compatible metadata and config exports', () => {
    expect(plugin.meta).toEqual({
      name: 'eslint-plugin-no-barrel-files',
      version: '1.4.0',
      namespace: 'no-barrel-files',
    });

    expect(plugin.configs?.recommended).toEqual([plugin.flat]);
    expect(plugin.configs?.['flat/recommended']).toEqual([plugin.flat]);
    expect(plugin.configs?.['legacy-recommended']).toEqual({
      plugins: ['no-barrel-files'],
      rules: {
        'no-barrel-files/no-barrel-files': 'error',
      },
    });

    expect(plugin.rules).toHaveProperty('prefer-source-imports');
  });
});
