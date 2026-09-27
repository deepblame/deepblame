import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    testTimeout: 30_000,
    alias: {
      // The editor supplies this module at runtime, so outside the editor there
      // is nothing to import. The stand-in lets the extension be driven here.
      vscode: fileURLToPath(new URL('packages/vscode/test/fake-editor.ts', import.meta.url)),
    },
  },
});
