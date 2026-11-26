// Сборка телефонной версии (папка mobile → dist-mobile → assets Android-приложения).
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Android WebView с подменёнными ответами может отбросить файлы, помеченные crossorigin, — убираем атрибут.
const noCrossorigin = (): Plugin => ({
  name: 'no-crossorigin',
  enforce: 'post',
  transformIndexHtml: (html) => html
    .replace(/\s+crossorigin(?:="[^"]*")?/g, '')
    // собранный скрипт — обычный (iife), а не модуль: работает и на старых WebView
    .replace(/<script type="module" src="(\.\/assets\/[^"]+)"><\/script>/, '<script defer src="$1"></script>'),
});

export default defineConfig({
  root: 'mobile',
  plugins: [react(), noCrossorigin()],
  base: './',
  // es2017 — чтобы работало и на старых телефонах (WebView от Chrome 61)
  build: { outDir: '../dist-mobile', emptyOutDir: true, target: ['es2017', 'chrome61'], modulePreload: false,
    rollupOptions: { output: { format: 'iife', inlineDynamicImports: true } } },
  server: { port: 5174 },
});
