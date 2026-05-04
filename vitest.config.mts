import { fileURLToPath } from 'url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@xctrace-analyzer/core': fileURLToPath(
        new URL('./packages/core/src/index.ts', import.meta.url)
      ),
    },
  },
});
