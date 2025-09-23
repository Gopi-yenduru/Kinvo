import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/',
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        secure: false,
      },
      '/ws': {
        target: 'http://localhost:3001', // your backend WebSocket server
        ws: true,                       // enable websocket proxy
        changeOrigin: true,
        secure: false,
      }
    }
  }
})
