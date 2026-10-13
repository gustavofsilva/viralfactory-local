import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: Number(env.WEB_PORT || 5173), strictPort: true,
      proxy: { '/api': `http://127.0.0.1:${env.API_PORT || 4310}` }
    }
  };
});
