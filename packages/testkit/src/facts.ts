import type { Arch, Capabilities, Facts, InitSystem, Platform } from '@dp/ports'

/**
 * 覆盖表。键名与 ports 的 Facts / Capabilities 一一对应，不发明任何新字段；
 * `capabilities` 是部分覆盖 —— 只写要改的那几项，其余能力保持构造器的默认值。
 * 未写到的键（包括显式写 undefined）一律回落默认，覆盖表不是「全部重置」的开关。
 */
interface FactsOverride {
  host?: string
  platform?: Platform
  arch?: Arch
  init?: InitSystem
  homedir?: string
  tmpdir?: string
  env?: Readonly<Record<string, string | undefined>>
  capabilities?: Partial<Capabilities>
  tools?: Readonly<Record<string, string | null>>
}

/** 全部能力为零值、只保留软链。这是各测试文件 facts 夹具反复重抄的那份公共底座 */
const BASE_CAPABILITIES: Capabilities = {
  canWrite: {},
  canChown: [],
  canSymlink: true,
  systemdScope: 'none',
  lingerEnabled: false,
  canBindPrivilegedPort: false,
  sudoAllowlist: [],
}

/**
 * 部分覆盖与整体替换必须分开：整体替换会强迫每个覆盖点重抄七项能力，
 * 抄漏一项就是一次「看起来在测 A、实际把 B 的前提改了」的假夹具。
 */
function mergeCapabilities(base: Capabilities, over: Partial<Capabilities> | undefined): Capabilities {
  if (over === undefined) return base
  const merged = { ...base } as Record<keyof Capabilities, unknown>
  for (const key of Object.keys(over) as (keyof Capabilities)[]) {
    const value = over[key]
    if (value !== undefined) merged[key] = value
  }
  return merged as Capabilities
}

/**
 * 一台「什么探测都没打开」的白板机：布局推导必然落到 user，迁移/推导类用例从这份出发，
 * 靠覆盖表逐项叠加能力。字段默认值取自各包测试文件里的近重复夹具（host 之外的值全部一致）。
 *
 * @param over 只覆盖写下来的键；`capabilities` 是部分覆盖
 * @returns 可直接注入 Runner / 推导函数的 Facts
 */
export function defaultFacts(over: FactsOverride = {}): Facts {
  return {
    host: 'test-host',
    platform: 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/u',
    tmpdir: '/tmp',
    env: {},
    capabilities: mergeCapabilities(BASE_CAPABILITIES, over.capabilities),
    tools: {},
    ...(over.host !== undefined ? { host: over.host } : {}),
    ...(over.platform !== undefined ? { platform: over.platform } : {}),
    ...(over.arch !== undefined ? { arch: over.arch } : {}),
    ...(over.init !== undefined ? { init: over.init } : {}),
    ...(over.homedir !== undefined ? { homedir: over.homedir } : {}),
    ...(over.tmpdir !== undefined ? { tmpdir: over.tmpdir } : {}),
    ...(over.env !== undefined ? { env: over.env } : {}),
    ...(over.tools !== undefined ? { tools: over.tools } : {}),
  }
}

/**
 * systemd 属 system scope 的 linux 目标机 —— cli / transport 侧「远端典型机」的公共子集。
 * 布局推导要走到 system / hybrid 分支，或断言要依赖 systemdScope 时，用这份而不是白板。
 *
 * @param over 同 {@link defaultFacts}
 * @returns 可直接注入 Runner / 推导函数的 Facts
 */
export function linuxFacts(over: FactsOverride = {}): Facts {
  return defaultFacts({ ...over, capabilities: { systemdScope: 'system', ...over.capabilities } })
}
