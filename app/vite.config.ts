import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 600, // three.js core is ~500kb on its own
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', 'postprocessing'],
          audio: ['tone'],
          react: ['react', 'react-dom'],
        },
      },
    },
  },
});
