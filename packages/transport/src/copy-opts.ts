/**
 * scp / sftp 这两个拷贝工具的命令行与 ssh 同宗，但有几个字母不是同一个意思。
 * 照搬 ssh 的选项不会报错，只会静默做错事。
 */

/**
 * 把 ssh 的选项片段改写成 scp / sftp 能吃的形状。
 *
 * @param sshOptions `buildRshArgv` 产出的选项片段，**不含**可执行文件那一项
 * @returns 可直接跟在 scp / sftp 可执行文件后面的选项
 */
export function sshOptionsForCopyTool(sshOptions: readonly string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < sshOptions.length; i += 1) {
    const opt = sshOptions[i]!
    // 这两个工具的 -p 是「保留时间戳与权限位」，端口是大写 -P。照搬 ssh 的
    // `-p 2222`：scp 不认 -p 带参数，会把 2222 当成一个源文件名；sftp 直接报未知选项。
    if (opt === '-p') {
      const port = sshOptions[i + 1]
      if (port !== undefined) {
        out.push('-P', port)
        i += 1
      }
      continue
    }
    // ssh 的 -T 是「不分配 pty」，scp 的 -T 是「关掉远端文件名校验」（那道校验挡的是
    // 服务端发来不在清单里的文件），sftp 压根没有这个选项。两种含义我们都不需要。
    if (opt === '-T') continue
    out.push(opt)
  }
  return out
}
