import { defineConfig } from 'vitest/config';

const config = defineConfig({
  test: {
    globals: true,
    exclude: ['**/cjs/**'],
  },
});

export default config;
