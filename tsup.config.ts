import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  treeshake: true,
  splitting: false,
  minify: false,
  target: 'es2019',
  platform: 'neutral', // Works in both node and browser
  tsconfig: './tsconfig.json',
});
