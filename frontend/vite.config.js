import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  
  server: {
    port: 3000,
    proxy: {
      // Local development proxy
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/stats': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/status': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/idphistory': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/slots': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/channels': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
      '/logs': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    }
  },
  
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  
  // Environment variable prefix
  envPrefix: 'VITE_',
})