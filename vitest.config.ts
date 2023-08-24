import { defineConfig } from 'vitest/config';

const config = defineConfig({
  test: {
    globals: true,
    exclude: ['**/cjs/**', 'node_modules', 'dist'],
  },
});

export default config;
