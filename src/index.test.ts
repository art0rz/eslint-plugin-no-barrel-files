import { describe, expect, it } from 'vitest';
import plugin from './index';

describe('plugin entrypoint', () => {
  it('exposes ESLint 10-compatible metadata and config exports', () => {
    expect(plugin.meta).toEqual({
      name: 'eslint-plugin-no-barrel-files',
      version: '1.4.0',
      namespace: 'no-barrel-files',
    });

    expect(plugin.configs?.default).toEqual({
      plugins: ['no-barrel-files'],
      rules: {
        'no-barrel-files/no-barrel-files': 'error',
      },
    });
    expect(plugin.configs?.recommended).toEqual({
      plugins: ['no-barrel-files'],
      rules: {
        'no-barrel-files/no-barrel-files': 'error',
        'no-barrel-files/prefer-source-imports': 'error',
      },
    });
    expect(plugin.configs?.['flat/default']).toEqual([plugin.flat]);
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
    expect(plugin.configs?.['legacy-default']).toEqual(plugin.configs?.default);
    expect(plugin.configs?.['legacy-recommended']).toEqual(plugin.configs?.recommended);

    expect(plugin.rules).toHaveProperty('prefer-source-imports');
  });
});
