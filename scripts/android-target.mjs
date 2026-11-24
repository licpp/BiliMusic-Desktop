const targets = {
  aarch64: { rust: 'aarch64-linux-android', abi: 'arm64-v8a', label: 'arm64' },
  armv7: { rust: 'armv7-linux-androideabi', abi: 'armeabi-v7a', label: 'armv7' },
}

export function androidTarget(args = [], defaultTarget = 'aarch64') {
  let target = defaultTarget, selected = false
  const rest = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--') { rest.push(...args.slice(i)); break }
    if (arg === '--target' || arg === '-t' || arg.startsWith('--target=')) {
      if (selected) throw new Error('Choose one Android target per build.')
      selected = true
      target = arg.startsWith('--target=') ? arg.slice('--target='.length) : args[++i]
      if (!Object.hasOwn(targets, target)) throw new Error('Android target must be aarch64 or armv7.')
    } else rest.push(arg)
  }
  const configurations = target === 'universal' ? Object.entries(targets) : [[target, targets[target]]]
  return {
    targets: configurations.map(([name]) => name),
    rust: configurations.map(([, config]) => config.rust),
    abis: configurations.map(([, config]) => config.abi),
    label: targets[target]?.label ?? target,
    args: rest,
  }
}

export function androidLargeScreenTarget(args = []) {
  const selected = androidTarget(args, 'universal')
  if (selected.args.includes('--split-per-abi')) throw new Error('Large-screen builds produce one APK. Remove --split-per-abi.')
  return selected
}
