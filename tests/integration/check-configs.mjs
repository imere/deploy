#!/usr/bin/env node
/**
 * 本机先把四份场景配置过一遍 schema —— 主机换成 local，不需要起容器。
 *
 * 它挡的是「配置形状不对」这一类：这类错误起完容器才暴露的话，一次来回是几分钟，
 * 而它其实在任何人起容器之前就能查出来。断言只认 DP.CONFIG.INVALID / DP.TPL.*，
 * 「连不上」「目录不存在」都算形状通过 —— 那是真机上才有的事。
 *
 * 用法：node tests/integration/check-configs.mjs（需要先 pnpm build）
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, configFor, LOCAL_HOST } from './scenarios.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BIN = join(ROOT, 'packages/cli/build/bin.js')
const TMP = join(ROOT, '.tmp', 'it')

mkdirSync(TMP, { recursive: true })

let bad = 0
for (const scenario of SCENARIOS) {
  const file = join(TMP, `${scenario.name}.json`)
  writeFileSync(file, JSON.stringify(configFor(scenario, LOCAL_HOST), null, 2), 'utf8')

  let out = ''
  try {
    out = execFileSync(process.execPath, [BIN, 'plan', '--json', '--config', file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (err) {
    out = String(err.stdout ?? '')
  }

  let parsed
  try {
    parsed = JSON.parse(out)
  } catch {
    parsed = undefined
  }
  const code = parsed?.error?.code
  const shapeBad = code === 'DP.CONFIG.INVALID' || (code ?? '').startsWith('DP.TPL')
  if (shapeBad) {
    bad += 1
    process.stdout.write(
      `✖ ${scenario.name}: ${code} @ ${parsed.error.path} —— ${parsed.error.message}\n`,
    )
  } else {
    process.stdout.write(`✔ ${scenario.name}${code === undefined ? '' : `（形状通过，随后 ${code}）`}\n`)
  }
}

if (bad > 0) {
  process.stdout.write(`${bad} 份配置的形状不对\n`)
  process.exit(1)
}
process.stdout.write(`${SCENARIOS.length} 份配置的形状都通过\n`)
