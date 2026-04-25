import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    build: {
      target: 'esnext',
      rollupOptions: {
        input: 'src/renderer/index.html',
      },
    },
    worker: {
      format: 'es',
    },
    // Prevent Vite from inlining the OCCT WASM binary
    assetsInclude: ['**/*.wasm'],
  },
});
