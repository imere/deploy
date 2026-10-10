
/**
 * UTC 时间戳：去掉 `-` `:` 与毫秒，`T` 换成 `-`。
 */
function utcStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')
}

/**
 * 真部署用的 releaseId：`web-20261002-093000`。
 */
export function releaseIdFor(name: string, now: Date): string {
  return `${name}-${utcStamp(now)}`
}

/**
 * 只读命令用的预览 id：`preview-web-20261002-093000`。
 */
export function previewReleaseId(name: string, now: Date): string {
  return `preview-${releaseIdFor(name, now)}`
}
