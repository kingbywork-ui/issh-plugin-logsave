import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('./plugin.json', import.meta.url), 'utf-8'))

export default defineConfig({
    build: {
        lib: {
            entry: resolve(__dirname, 'index.ts'),
            formats: ['es'],
            fileName: () => manifest.entry,
        },
        rollupOptions: { external: [] },
        outDir: 'dist',
        emptyOutDir: true,
        target: 'es2022',
        minify: false,
    },
})
