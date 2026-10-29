#!/usr/bin/env node
/** 从 `dp schema` 那份 JSON Schema 反查字段树，给 docs/config.md 的速查表用（不手工抄字段）。 */
import { configJsonSchema } from '../packages/schema/dist/lib/config.js'

const root = configJsonSchema()
const out = []

function typeOf(node) {
  if (node.enum !== undefined) return node.enum.join(' | ')
  if (node.anyOf !== undefined) return node.anyOf.map(typeOf).join(' / ')
  if (node.type === 'array') {
    const item = node.items ?? {}
    return item.type === 'object' ? '[]' : `${typeOf(item)}[]`
  }
  if (node.type === 'object') return '{}'
  return node.type ?? '?'
}

function walk(node, path, depth, required) {
  if (depth > 3) return
  const props = node.properties ?? {}
  for (const [name, child] of Object.entries(props)) {
    if ((path === '' && (name === 'defaults' || name === 'profiles')) || path === 'profiles') continue
    const p = path === '' ? name : `${path}.${name}`
    const isRequired = (required ?? []).includes(name)
    out.push(`| \`${p}\` | ${isRequired ? '必填' : '可选'} | ${typeOf(child)} |`)
    if (child.type === 'object') walk(child, p, depth + 1, child.required)
    else if (child.type === 'array' && (child.items ?? {}).type === 'object') {
      walk(child.items, `${p}[]`, depth + 1, child.items.required)
    } else if ((child.additionalProperties ?? {}).type === 'object') {
      walk(child.additionalProperties, `${p}.*`, depth + 1, child.additionalProperties.required)
    }
  }
  if ((node.additionalProperties ?? {}).type === 'object') {
    walk(node.additionalProperties, `${path}.*`, depth + 1, node.additionalProperties.required)
  }
}

walk(root, '', 0, root.required)
console.log('| 字段 | 必填 | 类型 / 取值 |')
console.log('| --- | --- | --- |')
console.log(out.join('\n'))
