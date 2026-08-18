import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] })
  ],
  server: {
    // Keeps the browser on one origin: /api is forwarded to the Python backend
    // (Data_Recon_Backend, `python run.py`), so no CORS is involved during development.
    proxy: {
      '/api': 'http://localhost:8787',
    },
  },
})
