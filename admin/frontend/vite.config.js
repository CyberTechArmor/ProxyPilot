import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'
import path from 'path'

export default defineConfig({
  plugins: [react()],
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
        // Function form so the ENTIRE CodeMirror/Lezer ecosystem lands in one
        // 'editor' chunk. The previous object form only listed a few lang
        // packages, so the shared CodeMirror core + the unlisted langs leaked
        // into the main chunk — splitting a package family across chunks creates
        // a circular init order that throws "Cannot access X before
        // initialization" once more than one module imports it. Grouping the
        // whole family together removes that hazard.
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](@codemirror|@uiw[\\/]react-codemirror|@lezer|codemirror|crelt|style-mod|w3c-keyname)[\\/]/.test(id)) return 'editor';
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom|scheduler)[\\/]/.test(id)) return 'vendor';
          if (/[\\/]node_modules[\\/]@radix-ui[\\/]/.test(id)) return 'ui';
          return undefined;
        },
      },
    },
  },
})
