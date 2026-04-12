import { defineConfig } from 'vitest/config';

const config = defineConfig({
  test: {
    globals: true,
    exclude: ['**/cjs/**', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
    },
  },
});

export default config;
