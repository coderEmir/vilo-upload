import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    proxy: {
      '/template-api': {
        target: 'http://127.0.0.1:3010',
        rewrite: (path) => path.replace(/^\/template-api/, '/api'),
      },
      '/remix-api': {
        target: 'http://127.0.0.1:3020',
        rewrite: (path) => path.replace(/^\/remix-api/, '/api'),
      },
    },
  },
});
