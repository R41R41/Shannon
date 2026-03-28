import react from '@vitejs/plugin-react';
import path from 'path';
import { defineConfig } from 'vite';

// Shannon-prod用: ポートを3001に変更
export default defineConfig(({ mode }) => {
  const backendPort = mode === 'dev' ? 15000 : 5001;
  return {
  plugins: [react()],
  server: {
    host: true,
    port: mode === 'test' ? 13001 : mode === 'dev' ? 13000 : 3001,
    strictPort: true,
    proxy: {
      '/api': `http://localhost:${backendPort}`,
    },
    allowedHosts: ['sh4nnon.com', 'www.sh4nnon.com', 'localhost'],
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
    }
  },
  // ホスト設定を追加
  preview: {
    host: true,
    port: 3001,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
    }
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      '@components': path.resolve(__dirname, './src/components'),
      '@styles': path.resolve(__dirname, './src/styles'),
      '@utils': path.resolve(__dirname, './src/utils'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
      '@common': path.resolve(__dirname, '../common/src'),
      '@common/*': path.resolve(__dirname, '../common/src/*'),
      'cronstrue/locales/ja': 'cronstrue/locales/ja.js',
    },
  },
};
});
