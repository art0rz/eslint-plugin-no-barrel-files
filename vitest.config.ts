import { defineConfig } from 'vitest/config';

const config = defineConfig({
  test: {
    globals: true,
    exclude: ['**/cjs/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});

export default config;
