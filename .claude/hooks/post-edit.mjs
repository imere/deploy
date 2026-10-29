#!/usr/bin/env node
/**
 * PostToolUse hook（Claude Code：Edit / MultiEdit / Write 落盘后触发）。
 *
 * stdin 收一个 JSON 事件，取 tool_input.file_path 做三件事：
 * 1. 路径卫生 —— .bak/.old/.orig 与仓库根下散落的 .log 只许进 .tmp/，备份靠 git；
 * 2. 单文件 eslint --fix —— 分号、import 重复这类风格问题当场修掉；
 *    fix 后仍有 error 的，把前几条喂回给模型（exit 2）。
 * 3. 约定扫描 —— 「本机」、章节号引用（§N）这类词面约定，lint 管不了的在这里拦。
 *
 * hook 自身任何异常都静默退出（exit 0）：hook 挂了不许阻塞会话，
 * 兜底防线在 CI 的 eslint / verify 链上。
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const fails = []

try {
  const ev = JSON.parse(readFileSync(0, 'utf8'))
  const file = ev?.tool_input?.file_path
  if (file) {
    const abs = resolve(file)

    if (/\.(bak|old|orig)$/i.test(abs)) {
      fails.push(`${abs} —— 备份靠 git，不落 .bak/.old；临时物进 .tmp/`)
    } else if (/\.log$/i.test(abs) && !abs.split(/[\\/]/).includes('.tmp')) {
      fails.push(`${abs} —— 日志类临时物进 .tmp/`)
    }

    if (/\.(ts|tsx|mts|mjs)$/.test(abs) && !abs.includes('node_modules')) {
      const eslintJs = join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js')
      const r = spawnSync(process.execPath, [eslintJs, '--fix', '--no-warn-ignored', abs], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
      })
      if (r.status === 1) {
        const head = `${r.stdout || ''}${r.stderr || ''}`
          .split('\n')
          .filter(Boolean)
          .slice(0, 12)
          .join('\n')
        fails.push(`eslint 仍有错误：\n${head}`)
      }
    }

    if (/\.(ts|tsx|mts|mjs|md)$/.test(abs) && !abs.includes('node_modules')) {
      const lines = readFileSync(abs, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (line.includes('本机')) {
          fails.push(`${abs}:${i + 1} —— 出现「本机」：用「宿主环境 / 目标机 / 当前环境」`)
        }
        if (/§\s?\d|\.md\s*§/.test(line)) {
          fails.push(`${abs}:${i + 1} —— 章节号引用（§N）会漂移：指向代码里的函数/常量，或就地把事实写清`)
        }
      })
      if (abs.endsWith('.md')) {
        lines.forEach((line, i) => {
          if (/\b(podman|docker compose)\b/.test(line)) {
            fails.push(
              `${abs}:${i + 1} —— 文档钉死容器工具名：用 <容器运行时> 占位（讲兼容性实测对比时保留具体名）`,
            )
          }
        })
      }
    }
  }
} catch {
  process.exit(0)
}

if (fails.length > 0) {
  console.error(fails.slice(0, 15).join('\n'))
  process.exit(2)
}
