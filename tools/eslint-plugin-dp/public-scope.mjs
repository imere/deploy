import { publicApiByFile } from './public-api.mjs'

/**
 * 判定「这个文件里的这个名字是不是公共 API」。按 packages 根缓存，进程内只算一次。
 *
 * @param {object} context ESLint 规则上下文
 * @returns {(name: string) => boolean} 名字是否公共 API；文件不在公共面内时恒 false
 */
export function publicApiFor(context) {
  const filePath = context.filename.split('\\').join('/')
  const marker = '/packages/'
  const at = filePath.lastIndexOf(marker)
  if (at === -1) return () => false
  const packagesRoot = context.cwd.split('\\').join('/') + '/packages'
  const key = packagesRoot
  let byFile = cache.get(key)
  if (!byFile) {
    byFile = publicApiByFile(packagesRoot)
    cache.set(key, byFile)
  }
  const names = byFile.get(filePath)
  if (!names) return () => false
  return (name) => names.has(name)
}

const cache = new Map()
