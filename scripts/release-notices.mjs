import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

// Run from the repository root after npm ci. No credentials or local source paths are exported.
const [target, output = 'THIRD_PARTY_LICENSES.json'] = process.argv.slice(2);
if (!target) throw new Error('Usage: node scripts/release-notices.mjs <rust-target> [output.json]');
async function texts(directory) {
  const files = [];
  for (const name of (await readdir(directory)).filter(name => /^(LICEN[CS]E|COPYING|NOTICE)/i.test(name))) {
    try { files.push({ name, content: await readFile(resolve(directory, name), 'utf8') }); } catch { /* Directories are not license text files. */ }
  }
  return files;
}
const metadata = JSON.parse(execFileSync('cargo', ['metadata','--locked','--manifest-path','src-tauri/Cargo.toml','--filter-platform',target,'--format-version','1'], { maxBuffer:32 * 1024 * 1024 }));
const packages = [];
for (const item of metadata.packages) packages.push({ name:item.name, version:item.version, ecosystem:'cargo', license:item.license || 'NOASSERTION', repository:item.repository, licenseFiles:await texts(dirname(item.manifest_path)) });
const lock = JSON.parse(await readFile('package-lock.json','utf8'));
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path) continue;
  let installed; try { installed=JSON.parse(await readFile(resolve(path,'package.json'),'utf8')); } catch { /* Platform-specific optional package not installed. */ }
  packages.push({ name:installed?.name || path.split('node_modules/').at(-1), version:item.version, ecosystem:'npm', license:installed?.license || item.license || 'NOASSERTION', licenseFiles:installed ? await texts(path) : [] });
}
await mkdir(dirname(resolve(output)),{recursive:true});
await writeFile(output,JSON.stringify({ project:'BiliMusic', version:JSON.parse(await readFile('package.json')).version, target, sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(), generatedAt:new Date().toISOString(), packages },null,2));
console.log(`Wrote ${packages.length} dependency declarations to ${output}`);
