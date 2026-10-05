import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/disk.ts', 'src/s3.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  target: 'es2022',
  external: ['hono', '@aws-sdk/client-s3', '@aws-sdk/lib-storage'],
})
