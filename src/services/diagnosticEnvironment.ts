import { invoke, isTauri } from '@tauri-apps/api/core'
import { isAndroid, isIOS, isLargeScreen, isOHOS } from './platform'

type Platform = 'Android' | 'iOS' | 'macOS' | 'Windows' | 'Linux' | 'HarmonyOS' | '浏览器'
type NativeEnvironment = {
  osName?: string
  osVersion?: string
  osBuild?: string
  apiLevel?: number
  deviceModel?: string
  architecture?: string
  webviewVersion?: string
  webviewPackage?: string
}

export type DiagnosticEnvironment = {
  system: string
  systemBuild?: string
  apiLevel?: number
  deviceModel?: string
  architecture?: string
  webview: string
  webviewPackage?: string
  largeScreen?: boolean
}

const engines: Record<Platform, { name: string; marker?: RegExp }> = {
  Android: { name: 'Android WebView', marker: /\bChrome\/([\d.]+)\b/ },
  Windows: { name: 'WebView2', marker: /\b(?:Edg|Chrome)\/([\d.]+)\b/ },
  macOS: { name: 'WKWebView', marker: /\bAppleWebKit\/([\d.]+)\b/ },
  iOS: { name: 'WKWebView', marker: /\bAppleWebKit\/([\d.]+)\b/ },
  Linux: { name: 'WebKitGTK', marker: /\bAppleWebKit\/([\d.]+)\b/ },
  HarmonyOS: { name: 'ArkWeb', marker: /\bArkWeb\/([\d.]+)\b/ },
  浏览器: { name: '浏览器' },
}

function systemFromUserAgent(platform: Platform, ua: string): [string, string | undefined] {
  switch (platform) {
    case 'Android': return [platform, ua.match(/\bAndroid (\d+(?:\.\d+){0,3})\b/)?.[1]]
    case 'iOS': return [platform, ua.match(/\b(?:CPU (?:iPhone )?|iPhone )OS ([\d_]+)\b/)?.[1]?.replace(/_/g, '.')]
    case 'macOS': return [platform, ua.match(/\bMac OS X ([\d_.]+)\b/)?.[1]?.replace(/_/g, '.')]
    case 'Windows': return ['Windows NT', ua.match(/\bWindows NT ([\d.]+)\b/)?.[1]]
    case 'HarmonyOS': return [platform, ua.match(/\b(?:OpenHarmony|HarmonyOS) (\d+(?:\.\d+){0,3})\b/)?.[1]]
    default: return [platform, undefined]
  }
}

function safeValue(value?: string) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  return trimmed && trimmed.length <= 96 && !/[:\\=\u0000-\u001f\u007f\u2028\u2029]/.test(trimmed) ? trimmed : undefined
}

const engineVersion = /^\d{1,6}(?:\.\d{1,6}){1,6}(?: (?:beta|dev|canary))?$/

export function describeDiagnosticEnvironment(platform: Platform, ua: string, native?: NativeEnvironment, largeScreen = false): DiagnosticEnvironment {
  const [uaSystem, uaVersion] = systemFromUserAgent(platform, ua)
  const osName = safeValue(native?.osName)
  const osVersion = safeValue(native?.osVersion)
  const systemBuild = safeValue(native?.osBuild)
  const system = osName || osVersion || systemBuild
    ? [osName || platform, osVersion].filter(Boolean).join(' ')
    : [uaSystem, uaVersion && `${uaVersion}（UA）`].filter(Boolean).join(' ')
  const engine = engines[platform]
  const reportedVersion = native?.webviewVersion?.trim() || ''
  const uaEngineVersion = (engine.marker && ua.match(engine.marker)?.[1]) || ''
  const version = engineVersion.test(reportedVersion) ? reportedVersion
    : engineVersion.test(uaEngineVersion) ? `${uaEngineVersion}（UA）` : undefined
  return {
    system,
    systemBuild,
    apiLevel: native?.apiLevel && Number.isSafeInteger(native.apiLevel) && native.apiLevel > 0 ? native.apiLevel : undefined,
    deviceModel: safeValue(native?.deviceModel),
    architecture: safeValue(native?.architecture),
    webview: [engine.name, version].filter(Boolean).join(' '),
    webviewPackage: safeValue(native?.webviewPackage),
    largeScreen,
  }
}

let cachedEnvironment: Promise<DiagnosticEnvironment> | undefined

export function readDiagnosticEnvironment(): Promise<DiagnosticEnvironment> {
  if (!cachedEnvironment) {
    const ua = navigator.userAgent
    const platform = isOHOS ? 'HarmonyOS' : isAndroid ? 'Android' : isIOS ? 'iOS'
      : /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '浏览器'
    const native = isTauri() ? new Promise<NativeEnvironment | undefined>(resolve => {
      const timeout = window.setTimeout(() => resolve(undefined), 1000)
      void invoke<NativeEnvironment>('diagnostic_environment')
        .then(resolve, () => resolve(undefined))
        .finally(() => window.clearTimeout(timeout))
    }) : Promise.resolve(undefined)
    cachedEnvironment = native.then(environment => describeDiagnosticEnvironment(platform, ua, environment, isLargeScreen))
  }
  return cachedEnvironment
}


export function formatDiagnosticEnvironment(version: string, environment: DiagnosticEnvironment) {
  return [
    `BiliMusic ${version}${environment.largeScreen ? ' · 车机 / TV' : ''}`,
    `系统 ${environment.system}`,
    environment.systemBuild && `系统构建 ${environment.systemBuild}`,
    environment.apiLevel && `系统 API ${environment.apiLevel}`,
    environment.deviceModel && `设备型号 ${environment.deviceModel}`,
    environment.architecture && `应用架构 ${environment.architecture}`,
    `WebView ${environment.webview}`,
    environment.webviewPackage && `WebView 包 ${environment.webviewPackage}`,
  ].filter(Boolean).join('\n')
}
