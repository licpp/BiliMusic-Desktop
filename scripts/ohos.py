#!/usr/bin/env python3
"""Isolated Harmony toolchain and source overlay; never edits the four-platform Cargo files."""
# Source-overlay/SDK compiler setup adapted from LeenHawk/tauri-harmony (MIT).
# Copyright (c) 2026 LeenHawk. See licenses/tauri-harmony-MIT.txt.
import argparse
import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import time
import tomllib
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'artifacts/ohos'
SOURCES = BASE / 'sources'
APP = BASE / 'workspace/src-tauri'
PINS = json.loads((ROOT / 'platforms/ohos/toolchain-pins.json').read_text())


def write_text(path, value):
    if not path.exists() or path.read_text() != value:
        path.write_text(value)


def run(args, **kwargs):
    subprocess.run([str(a) for a in args], check=True, **kwargs)


def fetch_source(item):
    name, pin = item
    dest = SOURCES / name
    marker = dest / '.bilimusic-revision'
    if marker.exists() and marker.read_text() == pin['revision']:
        return
    url = f"https://codeload.github.com/{pin['repository']}/tar.gz/{pin['revision']}"
    archive = BASE / f'{name}.tar.gz'
    print(f"Fetching {name} @ {pin['revision'][:12]}", flush=True)
    for attempt in range(4):
        try:
            with urllib.request.urlopen(url, timeout=120) as response, archive.open('wb') as output:
                shutil.copyfileobj(response, output)
            break
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2)
    stage = SOURCES / f'{name}.unpack'
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True)
    with tarfile.open(archive) as source:
        source.extractall(stage, filter='data')
    checkout, = stage.iterdir()
    shutil.rmtree(dest, ignore_errors=True)
    checkout.rename(dest)
    stage.rmdir()
    marker.write_text(pin['revision'])
    archive.unlink()


def patch_sources():
    # The experimental runtime still names the old Ability git source. Keep its
    # Rust crates and packaged HAR on exactly the same pinned checkout.
    for name in ('tauri', 'wry', 'tao'):
        for manifest in (SOURCES / name).rglob('Cargo.toml'):
            text = manifest.read_text()
            for package, directory in [('openharmony-ability', 'ability'), ('openharmony-ability-derive', 'derive')]:
                path = json.dumps(str(SOURCES / 'ability/crates' / directory))
                text = re.sub(
                    rf'^{package} = .*$',
                    lambda m: re.sub(r'git = "[^"]+"(?:, (?:rev|branch|tag) = "[^"]+")?',
                                     lambda _: f'path = {path}', m[0]),
                    text, flags=re.M)
            write_text(manifest, text)
    manifest = SOURCES / 'tauri/Cargo.toml'
    text = manifest.read_text()
    for name in ('wry', 'tao', 'cargo-mobile2'):
        text = re.sub(rf'^{name} = .*$', lambda _: f'{name} = {{ path = {json.dumps(str(SOURCES / name))} }}', text, flags=re.M)
    write_text(manifest, text)


def link(source, dest):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.is_symlink():
        dest.unlink()
    elif dest.exists():
        raise RuntimeError(f'Refusing to replace non-symlink {dest}')
    dest.symlink_to(source, target_is_directory=source.is_dir())


def overlay():
    APP.mkdir(parents=True, exist_ok=True)
    # Changes to shared Rust modules are immediately visible, without copying.
    for name in ('src', 'build.rs', 'icons'):
        link(ROOT / 'src-tauri' / name, APP / name)
    link(BASE / 'frontend', APP.parent / 'dist')
    manifest = (ROOT / 'src-tauri/Cargo.toml').read_text()
    # Preserve all common dependencies from the authoritative manifest. Platform
    # dependency tables are irrelevant to this OHOS-only overlay.
    common, rest = manifest.split('[target.', 1)
    common = re.sub(r'^tauri-plugin-(dialog|opener) = .*\n', '', common, flags=re.M)
    profiles = '[profile.release]' + rest.split('[profile.release]', 1)[1].split('[patch.crates-io]', 1)[0]
    common += 'napi-ohos = "1.2"\nnapi-derive-ohos = "1.2"\n'
    common += f'tauri-plugin-ohos-player = {{ path = {json.dumps(str(ROOT / "native/ohos-player"))} }}\n'
    patches = '\n[patch.crates-io]\n'
    for name in ('tauri', 'tauri-build', 'tauri-codegen', 'tauri-macros', 'tauri-utils', 'tauri-runtime', 'tauri-runtime-wry'):
        patches += f'{name} = {{ path = {json.dumps(str(SOURCES / "tauri/crates" / name))} }}\n'
    for name, path in [('wry', 'wry'), ('tao', 'tao'), ('openharmony-ability', 'ability/crates/ability'), ('openharmony-ability-derive', 'ability/crates/derive')]:
        patches += f'{name} = {{ path = {json.dumps(str(SOURCES / path))} }}\n'
    write_text(APP / 'Cargo.toml', common + '\n' + profiles + patches)
    lock = ROOT / 'platforms/ohos/Cargo.lock'
    if lock.exists():
        write_text(APP / 'Cargo.lock', lock.read_text())
    config = json.loads((ROOT / 'src-tauri/tauri.conf.json').read_text())
    config['build']['beforeBuildCommand'] = ''
    config['build']['beforeDevCommand'] = ''
    config['identifier'] = 'app.bilimusic.harmony'
    config['bundle']['targets'] = []
    config['app']['windows'] = [{'label': 'main', 'title': 'BiliMusic', 'width': 400, 'height': 800, 'minWidth': 0, 'minHeight': 0}]
    write_text(APP / 'tauri.conf.json', json.dumps(config, ensure_ascii=False, indent=2) + '\n')
    capability = json.loads((ROOT / 'src-tauri/capabilities/default.json').read_text())
    capability['permissions'] = [p for p in capability['permissions'] if not p.startswith('dialog:')]
    capability['permissions'].append('ohos-player:default')
    (APP / 'capabilities').mkdir(exist_ok=True)
    write_text(APP / 'capabilities/default.json', json.dumps(capability, indent=2) + '\n')


def prepare_hap():
    project = APP / 'gen/ohos'
    if not project.exists():
        raise RuntimeError('Run ohos.py init before building')
    # Source-only HAR from the exact same Ability revision used by Rust.
    ability = BASE / 'ability-har'
    shutil.copytree(SOURCES / 'ability/package', ability, dirs_exist_ok=True)
    shutil.copytree(SOURCES / 'ability/native_ability/src/main/ets', ability / 'src/main/ets', dirs_exist_ok=True)
    shutil.copytree(SOURCES / 'ability/native_ability/src/main/resources', ability / 'src/main/resources', dirs_exist_ok=True)
    # A directory dependency is treated as a project module by the ArkTS
    # resolver. Package the upstream source HAR so normalized imports resolve
    # within the library, just like the upstream ohrs artifact command.
    archive = project / 'vendor/ability.har'
    archive.parent.mkdir(exist_ok=True)
    with tarfile.open(archive, 'w:gz') as package:
        package.add(ability, arcname='package')
    entry = project / 'entry'
    for media in (project / 'AppScope/resources/base/media', entry / 'src/main/resources/base/media'):
        shutil.copy2(ROOT / 'public/app-icon.png', media / 'app_icon.png')
    ets = entry / 'src/main/ets/entryability'
    shutil.copy2(ROOT / 'platforms/ohos/EntryAbility.ets', ets / 'EntryAbility.ets')
    shutil.copy2(ROOT / 'native/ohos-player/ohos/PlayerPlugin.ets', ets / 'PlayerPlugin.ets')
    native_types = entry / 'src/main/cpp/types/libbilimusic_lib'
    native_types.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / 'platforms/ohos/native.d.ts', native_types / 'Index.d.ts')
    (native_types / 'oh-package.json5').write_text(json.dumps({'name': 'libbilimusic_lib.so', 'version': '1.0.0', 'types': './Index.d.ts'}))
    (entry / 'oh-package.json5').write_text(json.dumps({'name': 'entry', 'version': '0.3.0', 'dependencies': {
        'libentry.so': 'file:./src/main/cpp/types/libentry',
        'libbilimusic_lib.so': 'file:./src/main/cpp/types/libbilimusic_lib',
        '@ohos-rs/ability': 'file:../vendor/ability.har',
    }}, indent=2))
    # Templates are JSON5, parsed by the Node bundled with DevEco, not by regex.
    script = """
const fs=require('fs'); const JSON5=require(process.argv[1]); const root=process.argv[2];
const edit=(file,fn)=>{const path=root+'/'+file; const value=JSON5.parse(fs.readFileSync(path,'utf8'));fn(value);fs.writeFileSync(path,JSON.stringify(value,null,2)+'\\n')};
edit('build-profile.json5',v=>{for(const p of v.app.products){delete p.signingConfig;p.compatibleSdkVersion='6.0.0(20)';p.targetSdkVersion='26.0.0';}});
edit('AppScope/app.json5',v=>{v.app.bundleName='app.bilimusic.harmony';v.app.icon='$media:app_icon';v.app.versionName='0.3.0';v.app.versionCode=30000;});
edit('entry/src/main/module.json5',v=>{v.module.abilities[0].icon='$media:app_icon';v.module.abilities[0].startWindowIcon='$media:app_icon';v.module.abilities[0].backgroundModes=['audioPlayback'];v.module.requestPermissions=[{name:'ohos.permission.INTERNET'},{name:'ohos.permission.KEEP_BACKGROUND_RUNNING'}];});
edit('entry/src/main/resources/base/element/string.json',v=>{for(const s of v.string){if(s.name==='EntryAbility_label'||s.name==='module_desc')s.value='BiliMusic';}});
"""
    env, _ = sdk_env('aarch64')
    studio = Path(env.get('DEVECO_HOME', '/Applications/DevEco-Studio.app/Contents'))
    sdk = Path(env['OHOS_HOME'])
    metadata = json.loads((sdk / 'native/oh-uni-package.json').read_text())
    api = metadata['apiVersion']
    # Huawei changed version notation starting with API 26.
    target_sdk = metadata['platformVersion'] if int(api.split('.')[0]) >= 26 else f"{metadata['platformVersion']}({api})"
    version = json.loads((ROOT / 'package.json').read_text())['version']
    native_version = tomllib.loads((ROOT / 'src-tauri/Cargo.toml').read_text())['package']['version']
    if version != native_version:
        raise RuntimeError('Frontend and native bundle versions must match')
    android = json.loads((ROOT / 'src-tauri/tauri.android.conf.json').read_text())
    app_version = json.dumps({'version': version, 'code': android['bundle']['android']['versionCode'], 'target': target_sdk})
    json5 = studio / 'tools/hvigor/hvigor-ohos-plugin/node_modules/json5'
    script = script.replace("const root=process.argv[2];", "const root=process.argv[2]; const version=JSON.parse(process.argv[3]);")
    script = script.replace("delete p.signingConfig;", "if(!v.app.signingConfigs?.some(c=>c.name===p.signingConfig))delete p.signingConfig;")
    script = script.replace("p.targetSdkVersion='26.0.0'", 'p.targetSdkVersion=version.target')
    script = script.replace("v.app.versionName='0.3.0';v.app.versionCode=30000;", 'v.app.versionName=version.version;v.app.versionCode=version.code;')
    run(['node', '-e', script, json5, project, app_version], env=env)


def sdk_env(target):
    env = os.environ.copy()
    sdk = Path(env.get('OHOS_HOME', '/Applications/DevEco-Studio.app/Contents/sdk/default/openharmony'))
    studio = Path(env.get('DEVECO_HOME', '/Applications/DevEco-Studio.app/Contents'))
    if not (sdk / 'native/llvm/bin/clang').exists():
        raise RuntimeError('Set OHOS_HOME to the SDK containing native, ets and toolchains')
    env.update(OHOS_HOME=str(sdk), OHOS_NDK_HOME=str(sdk), OHOS_NATIVE_HOME=str(sdk / 'native'), DEVECO_SDK_HOME=str(sdk.parent.parent),
               JAVA_HOME=str(studio / 'jbr/Contents/Home'),
               VITE_BILIMUSIC_PLATFORM='ohos', CARGO_TARGET_DIR=str(BASE / 'target'))
    env['PATH'] = os.pathsep.join(str(x) for x in [BASE / 'tools/bin', studio / 'tools/node/bin', studio / 'tools/ohpm/bin', studio / 'tools/hvigor/bin', sdk / 'toolchains']) + os.pathsep + env['PATH']
    arch = {'aarch64': 'aarch64', 'x86_64': 'x86_64'}[target]
    triple = f'{arch}-unknown-linux-ohos'
    wrappers = BASE / 'compilers'
    wrappers.mkdir(parents=True, exist_ok=True)
    for compiler in ('clang', 'clang++'):
        wrapper = wrappers / f'{arch}-{compiler}'
        write_text(wrapper, f'#!/bin/sh\nexec "{sdk}/native/llvm/bin/{compiler}" --target={arch}-linux-ohos --sysroot="{sdk}/native/sysroot" -D__MUSL__ "$@"\n')
        wrapper.chmod(0o755)
    underscore = triple.replace('-', '_')
    env.update({f'CC_{underscore}': str(wrappers / f'{arch}-clang'), f'CXX_{underscore}': str(wrappers / f'{arch}-clang++'),
                f'AR_{underscore}': str(sdk / 'native/llvm/bin/llvm-ar'), f'RANLIB_{underscore}': str(sdk / 'native/llvm/bin/llvm-ranlib'),
                f'CXXSTDLIB_{underscore}': 'c++', f'CARGO_TARGET_{underscore.upper()}_LINKER': str(wrappers / f'{arch}-clang')})
    return env, triple


def verify_hap(target):
    abi = {'aarch64': 'arm64-v8a', 'x86_64': 'x86_64'}[target]
    machine = {'aarch64': 183, 'x86_64': 62}[target]
    hap = APP / 'gen/ohos/entry/build/default/outputs/default/entry-default-unsigned.hap'
    with zipfile.ZipFile(hap) as package:
        if package.testzip() is not None:
            raise RuntimeError('HAP ZIP integrity check failed')
        metadata = json.loads(package.read('module.json'))
        version = json.loads((ROOT / 'package.json').read_text())['version']
        if metadata['app']['versionName'] != version or metadata['app']['bundleName'] != 'app.bilimusic.harmony':
            raise RuntimeError('Unexpected HAP bundle identity/version')
        if metadata['app']['icon'] != '$media:app_icon' or metadata['module']['abilities'][0]['icon'] != '$media:app_icon':
            raise RuntimeError('HAP is using a template icon')
        if package.read('resources/base/media/app_icon.png') != (ROOT / 'public/app-icon.png').read_bytes():
            raise RuntimeError('HAP icon differs from the shared application icon')
        library = f'libs/{abi}/libbilimusic_lib.so'
        binary = package.read(library)
        if binary[:4] != b'\x7fELF' or int.from_bytes(binary[18:20], 'little') != machine:
            raise RuntimeError('HAP contains the wrong native architecture')
        if binary != (APP / f'gen/ohos/entry/libs/{abi}/libbilimusic_lib.so').read_bytes():
            raise RuntimeError('Packaged native library differs from the build output')
        for symbol in ('bilimusicOhosState', 'bilimusicOhosListening', 'tauriOhosPluginInitialize', 'tauriOhosPluginResponse'):
            if symbol.encode() not in binary:
                raise RuntimeError(f'Native bridge export missing: {symbol}')
        if len(package.read('ets/modules.abc')) < 1000:
            raise RuntimeError('ArkTS bytecode is missing')
    output = BASE / f'BiliMusic_{version}_HarmonyOS_NEXT_{abi}-unsigned.hap'
    shutil.copy2(hap, output)
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    dirty = bool(subprocess.check_output(['git', 'status', '--porcelain'], cwd=ROOT, text=True).strip())
    report = {'bundle': 'app.bilimusic.harmony', 'version': version, 'architecture': abi,
              'source_commit': head, 'working_tree_dirty': dirty, 'toolchain': PINS,
              'artifact': str(output), 'bytes': output.stat().st_size,
              'sha256': hashlib.sha256(output.read_bytes()).hexdigest(),
              'verified': ['zip-integrity', 'bundle-version', 'shared-icon', 'native-architecture', 'native-library-identity', 'native-bridge-exports', 'arkts-bytecode'],
              'signed': False, 'release_status': 'experimental'}
    write_text(BASE / 'build-report.json', json.dumps(report, indent=2) + '\n')
    print(f'Verified HAP: {output}', flush=True)


def main():
    if sys.version_info < (3, 12):
        raise RuntimeError('Python 3.12+ is required (macOS: /opt/homebrew/bin/python3 scripts/ohos.py ...)')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['prepare', 'tools', 'check', 'init', 'build', 'verify', 'update-lock'])
    parser.add_argument('--target', choices=['aarch64', 'x86_64'], default='aarch64')
    args = parser.parse_args()
    if args.action == 'verify':
        verify_hap(args.target)
        return
    BASE.mkdir(parents=True, exist_ok=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        list(pool.map(fetch_source, PINS.items()))
    patch_sources()
    overlay()
    env, triple = sdk_env(args.target)
    if args.action == 'prepare':
        print(APP)
        return
    run(['rustup', 'target', 'add', triple], env=env)
    if args.action == 'tools':
        # Isolated prefix: leaves the installed stable Tauri CLI untouched.
        run(['cargo', 'install', '--path', SOURCES / 'tauri/crates/tauri-cli', '--root', BASE / 'tools', '--locked', '--no-default-features', '--features', 'native-tls'], env=env)
        run(['cargo', 'install', 'ohrs', '--version', '=1.5.0', '--locked', '--root', BASE / 'tools'], env=env)
    elif args.action == 'check':
        run(['cargo', 'check', '--locked', '--target', triple, '--lib'], cwd=APP, env=env)
    elif args.action == 'update-lock':
        run(['cargo', 'generate-lockfile'], cwd=APP, env=env)
        shutil.copy2(APP / 'Cargo.lock', ROOT / 'platforms/ohos/Cargo.lock')
    elif args.action == 'init':
        run(['cargo', 'tauri', 'ohos', 'init', '--ci', '--skip-targets-install'], cwd=APP, env=env)
        prepare_hap()
    elif args.action == 'build':
        prepare_hap()
        run(['npm', 'run', 'build', '--', '--outDir', BASE / 'frontend'], cwd=ROOT, env={**os.environ, 'VITE_BILIMUSIC_PLATFORM': 'ohos'})
        run(['cargo', 'tauri', 'ohos', 'build', '--ci', '--target', args.target, '--', '--locked'], cwd=APP, env=env)
        verify_hap(args.target)


if __name__ == '__main__':
    main()
