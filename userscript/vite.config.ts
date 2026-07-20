import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    minify: 'terser',
    terserOptions: {
      compress: {
        drop_console: false, // Keep consoles for the plugin
        passes: 2
      },
      mangle: {
        toplevel: true, // Mangle top level variables
      }
    }
  },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'Zip it - VaultWares',
        namespace: 'clopeux-scripts',
        version: '8.4.0',
        description: 'VaultWares API Download Manager Browser Helper Script Addon Bridge for Media Cloud Management on Local Server...',
        author: 'Clopeux',
        match: ['*://*/*'],
        icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAxMDAgMTAwIj48dGV4dCB5PSIuOWVtIiBmb250LXNpemU9IjkwIj7ihZk8L3RleHQ+PC9zdmc+',
        grant: [
          'GM_xmlhttpRequest',
          'GM_addStyle',
          'GM_setClipboard',
          'GM_registerMenuCommand',
          'GM_getValue',
          'GM_setValue',
          'GM_notification'
        ],
        connect: [
          'localhost',
          '127.0.0.1',
          '*'
        ]
      },
      build: {
        fileName: 'tampermonkey_script.js', // Match the old filename perfectly
      }
    }),
  ],
});
