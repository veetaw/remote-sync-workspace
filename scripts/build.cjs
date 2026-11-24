require('esbuild').buildSync({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  outfile: 'dist/extension.js',
  external: ['vscode', 'cpu-features', '*.node'],
  sourcemap: true,
});
