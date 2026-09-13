import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@main': resolve('src/main'),
    },
  },
  test: {
    // Node by default; renderer tests opt into jsdom with a
    // `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    reporters: 'default',
  },
});
