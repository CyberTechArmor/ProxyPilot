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
