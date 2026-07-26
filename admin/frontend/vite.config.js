import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'
import { readFileSync } from 'fs'

// The service worker is EMITTED, not shipped as a static file, so it carries
// this build's id in its bytes.
//
// That matters for the "never stuck on an old cache" requirement. A browser
// only installs a new worker when sw.js differs BYTE-WISE from the installed
// one. A hand-written static sw.js never changes, so a deploy would leave the
// old worker — and its old caches — in charge indefinitely. Stamping the build
// id guarantees a byte difference on every build.
//
// The runtime strategy is the other half and is the one that actually protects
// you: navigations are network-FIRST, so even an old worker serves fresh HTML,
// and fresh HTML names the new content-hashed assets.
function serviceWorkerPlugin() {
  const buildId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    name: 'proxypilot-service-worker',
    apply: 'build',
    generateBundle() {
      const src = readFileSync(path.resolve(__dirname, 'src/sw-template.js'), 'utf8')
        .replace(/__BUILD_ID__/g, buildId);
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
    },
  };
}


export default defineConfig({
  plugins: [react(), serviceWorkerPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  // CI-friendly settings
  clearScreen: false,
  logLevel: 'info',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    // Optimize for low-memory VPS builds
    sourcemap: false,
    minify: 'esbuild',
    target: 'es2020',
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      // Disable parallel processing to prevent hangs in constrained environments
      maxParallelFileOps: 1,
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          ui: ['@radix-ui/react-dialog', '@radix-ui/react-select', '@radix-ui/react-switch', '@radix-ui/react-tabs'],
          editor: ['@uiw/react-codemirror', '@codemirror/lang-javascript', '@codemirror/lang-html', '@codemirror/lang-css', '@codemirror/lang-json'],
        },
      },
    },
  },
})
