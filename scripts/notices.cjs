const fs = require('node:fs');
const path = require('node:path');
const visited = new Set();
const notices = [
  '# Third-party notices',
  '',
  'Runtime packages bundled with Remote Sync Workspace. Optional native accelerators are not shipped.',
  '',
];
function visit(name, parent) {
  let pkgPath;
  try {
    pkgPath = require.resolve(name + '/package.json', { paths: [parent] });
  } catch {
    try {
      let dir = path.dirname(require.resolve(name, { paths: [parent] }));
      while (!fs.existsSync(path.join(dir, 'package.json')))
        dir = path.dirname(dir);
      pkgPath = path.join(dir, 'package.json');
    } catch {
      return;
    }
  }
  if (visited.has(pkgPath)) return;
  visited.add(pkgPath);
  const pkg = JSON.parse(fs.readFileSync(pkgPath));
  const dir = path.dirname(pkgPath);
  if (name === 'cpu-features' || name === 'nan' || name === 'buildcheck')
    return;
  notices.push(
    `## ${pkg.name} ${pkg.version}`,
    '',
    `License: ${pkg.license || 'see package notice'}`,
    '',
  );
  for (const file of fs
    .readdirSync(dir)
    .filter((f) =>
      /^(license|licence|copying|copyright|notice)(\.|$)/i.test(f),
    )) {
    const full = path.join(dir, file);
    if (fs.statSync(full).isFile())
      notices.push('```text', fs.readFileSync(full, 'utf8').trim(), '```', '');
  }
  for (const dependency of Object.keys(pkg.dependencies || {}))
    visit(dependency, dir);
}
for (const name of Object.keys(require('../package.json').dependencies))
  visit(name, process.cwd());
fs.writeFileSync('THIRD_PARTY_NOTICES.md', notices.join('\n'));
