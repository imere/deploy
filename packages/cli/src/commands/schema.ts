/**
 * `dp schema` —— 导出 configJsonSchema。
 *
 * 存在的意义很具体：用户把 `"$schema": "./deploy.schema.json"` 写进
 * deploy.config.json 之后，编辑器立刻能做补全与实时校验。这类问题（字段名
 * 拼错、少写一个必填项）在没有 schema 时只能等到运行时才炸。
 */
import { configJsonSchema } from '@dp/schema'

export async function runSchema(context: import('../run.js').RunContext, flags: import('../run.js').ResolvedFlags): Promise<number> {
  const json = `${JSON.stringify(configJsonSchema(), null, 2)}\n`

  if (flags.out === undefined) {
    context.out(json)
    return 0
  }

  // 唯一的写操作：用户显式要求 --out 才写，且写到用户给的那个绝对路径
  const { promises: fs } = await import('node:fs')
  const { resolve: resolvePath } = await import('node:path')
  const target = resolvePath(context.cwd, flags.out)
  try {
    await fs.writeFile(target, json, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    context.error(`写 schema 失败：${target}`, `检查目录是否存在、当前用户是否有写权限。Node 说：${message}`)
    return 1
  }
  context.error(`已写出 ${target}`, '把 "$schema": "./deploy.schema.json" 加进你的 deploy.config.json 即可获得补全')
  return 0
}
