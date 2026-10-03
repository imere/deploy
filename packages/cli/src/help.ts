/**
 * 帮助文本。**纯函数** —— 只拼字符串，不读环境、不看 argv。
 *
 * 两类读者同时在用：人靠「这段到底干什么」和例子；
 * agent 靠「用法行 + 开关全名 + 退出码」照着拼命令行。所以每条帮助都必须同时
 * 给出：用途 / 用法行 / 开关 / **至少两个可直接复制的例子** / 相关命令。
 * 缺任何一样，对其中一类读者就是死的 —— 而 agent 读不懂就会瞎猜参数。
 */
import { EXIT_CODE_ROWS } from './output.js'

export interface CommandDoc {
  readonly name: string
  /** 一句话用途 */
  readonly summary: string
  readonly usage: string
  /** 本命令专属开关（全局开关在帮助里单列） */
  readonly flags: readonly (readonly [string, string])[]
  /** 可直接复制的真实命令行，至少两个 */
  readonly examples: readonly string[]
  /** 相关命令名 */
  readonly related: readonly string[]
  /** 这个命令最可能撞到的错误 → 怎么修 */
  readonly commonErrors: readonly (readonly [string, string])[]
  /** 后续回合才实现 */
  readonly implemented: boolean
}

const GLOBAL_FLAGS: readonly (readonly [string, string])[] = [
  ['-c, --config <path>', '指定配置文件；不给则按 DP_CONFIG → 自动发现'],
  ['--env <name>', '环境档案名，对应 config.profiles.<name>'],
  ['--host <id>', '目标主机；候选多于一个又没指定时报错并列出可选值'],
  ['--project <name>', '项目名；候选多于一个又没指定时报错并列出可选值'],
  ['--facts <file>', '从 JSON 文件读目标机事实，跳过真实探测（离线复现 / CI 用）'],
  ['--json', '结果以 JSON 打到 stdout，日志改走 stderr'],
  ['--log-format <fmt>', 'json | pretty | logfmt；不给时非 TTY 自动用 json'],
  ['--log-level <lvl>', 'trace | debug | info | warn | error，默认 info'],
  ['--log-file <path>', '日志额外落一份文件'],
  ['-v, --verbose', '错误时打印完整 stack'],
  ['-q, --quiet', '只留 warn 及以上'],
  ['-h, --help', '帮助，等价于 `dp help [命令]`'],
  ['-V, --version', '打印版本'],
]

export const COMMANDS: readonly CommandDoc[] = [
  {
    name: 'plan',
    summary: '干跑：算出将执行哪些步骤、发布根落在哪。不碰目标机，不建目录不写文件',
    usage: 'dp plan [--config <path>] [--project <name>] [--host <id>] [--all] [--facts <file>] [--json]',
    flags: [
      ['--project <name>', '只算这一个项目'],
      ['--host <id>', '只算这一个主机'],
      ['--all', '所有项目都算（不能与 --host 同用）'],
      ['--facts <file>', '复用存下来的 Facts，不连目标机'],
    ],
    examples: [
      'dp plan --project web --host local',
      'dp plan --facts .tmp/facts.json --json > .tmp/plan.json',
      'dp plan --config ./deploy/prod.json --env prod --host web-01',
    ],
    related: ['facts', 'schema', 'apply'],
    commonErrors: [
      ['CONFIG_INVALID', '配置文件不存在 / 有冲突 / 校验不过；报错里会给出具体路径'],
      ['DP.PATH.NOT_WRITABLE', '没有可写的发布根；用 release.root 显式指定，或让运维授权候选之一'],
      ['DP.SOURCE.EMPTY', 'source 枚举结果为空；先构建，或检查 include/exclude'],
    ],
    implemented: true,
  },
  {
    name: 'facts',
    summary: '打印目标机的实证事实（能力集 + 探测说明），供 plan 离线复用',
    usage: 'dp facts [--config <path>] [--host <id>] [--json]',
    flags: [
      ['--host <id>', '探测哪台机器'],
      ['--json', '输出完整 Facts 结构'],
    ],
    examples: [
      'dp facts --host local --json',
      'dp facts --host local --json > .tmp/facts.json',
    ],
    related: ['plan'],
    commonErrors: [
      ['DP.SSH.TOOL_MISSING', '本机没有 ssh 可执行文件；装 OpenSSH 或改用本机目标'],
      ['DP.SSH.HOST_KEY_UNKNOWN', '主机密钥不认识；先手工 ssh 一次确认指纹，或显式配 knownHosts'],
    ],
    implemented: true,
  },
  {
    name: 'schema',
    summary: '导出 configJsonSchema，让编辑器对 deploy.config.json 有补全与实时校验',
    usage: 'dp schema [--out <file>]',
    flags: [['--out <file>', '写到文件；不给则打到 stdout']],
    examples: ['dp schema', 'dp schema --out ./deploy.schema.json'],
    related: ['plan'],
    commonErrors: [['DP.PATH.NOT_WRITABLE', '--out 的目录不存在或不可写；先创建目录']],
    implemented: true,
  },
  {
    name: 'help',
    summary: '打印根帮助或某个命令的帮助',
    usage: 'dp help [命令]',
    flags: [],
    examples: ['dp help', 'dp help plan', 'dp plan --help'],
    related: ['plan', 'facts', 'schema'],
    commonErrors: [],
    implemented: true,
  },
  {
    name: 'apply',
    summary: '真实部署：写入 releases/<id> 并原子切换 current。默认真执行',
    usage: 'dp apply [--config <path>] [--env <name>] [--project <name>] [--host <id>] [--all] [--facts <file>] [--dry-run] [--json]',
    flags: [
      ['--dry-run', '只算不写：打印将要执行的步骤，一个字节都不落盘，退出 0'],
      ['--project <name>', '只部署这一个项目'],
      ['--host <id>', '只部署这一台主机'],
      ['--all', '所有项目都部署（不能与 --host 同用）'],
      ['--facts <file>', '复用存下来的 Facts，跳过真实探测（**仅限 local 主机**：远端写入必须有真连接）'],
    ],
    examples: [
      'dp apply --project web --host local',
      'dp apply --project web --host local --dry-run',
      'dp apply --config ./deploy/prod.json --env prod --host web-01 --json',
    ],
    related: ['plan', 'facts', 'rollback'],
    commonErrors: [
      ['DP.SOURCE.EMPTY', 'source 枚举结果为空；先构建。注意 "./dist" 与 "./dist/**" 的区别'],
      ['DP.PATH.NOT_WRITABLE', '发布根建不出来；用 release.root 显式指定一个可写目录'],
      ['DP.VERIFY.FAILED', '健康检查未通过，**已自动回退**到上一版；坏版本留在 releases/<id> 待查。退出码 2'],
    ],
    implemented: true,
  },
  {
    name: 'rollback',
    summary: '把 current 切回上一版。回滚后再验一次健康，坏版本留着不清',
    usage: 'dp rollback [--config <path>] [--env <name>] [--project <name>] [--host <id>] [--all] [--json]',
    flags: [
      ['--project <name>', '只回滚这一个项目'],
      ['--host <id>', '只回滚这一台主机'],
      ['--all', '所有项目都回滚（不能与 --host 同用）'],
      ['--json', '输出 { host, project, releaseRoot, from, to, needsHealing, warnings }'],
    ],
    examples: [
      'dp rollback --host local --project web',
      'dp rollback --host web-01 --project api --json',
      'dp status --all            // 先看有没有可回退的版本',
    ],
    related: ['apply', 'status', 'verify'],
    commonErrors: [
      ['DP.VERIFY.FAILED', '没有可回退的版本（首次部署 / 只有一个版本）；先跑 dp apply 部署出历史'],
      ['DP.VERIFY.FAILED', '已切回但新 current 健康检查不过 → needsHealing=true、退出码 2，需要人工介入'],
    ],
    implemented: true,
  },
  {
    name: 'verify',
    summary: '只对当前 current 跑健康检查。不通过退出码 2，适合放进 CI 卡流水线',
    usage: 'dp verify [--config <path>] [--env <name>] [--project <name>] [--host <id>] [--all] [--json]',
    flags: [
      ['--project <name>', '只验这一个项目'],
      ['--host <id>', '只验这一台主机'],
      ['--all', '所有项目都验（不能与 --host 同用）'],
      ['--json', '输出 { host, project, releaseRoot, releaseId, ok, reason, warnings }'],
    ],
    examples: [
      'dp verify --host local --project web',
      'dp verify --all --json > .tmp/verify.json',
      'dp verify --host web-01 --project api --quiet    # CI 里只留告警',
    ],
    related: ['status', 'apply', 'rollback'],
    commonErrors: [
      ['DP.VERIFY.FAILED', '健康检查未通过；退出码 2。`--json` 的 error.code 才是可靠信号（退出码 2 也用于用法错）'],
      ['DP.VERIFY.FAILED', '尚未部署过，没有可校验的 current；先跑 dp apply'],
    ],
    implemented: true,
  },
  {
    name: 'status',
    summary: '查看目标机当前 release 状态：当前版本、上一版、共几版、健康与否。零副作用',
    usage: 'dp status [--config <path>] [--env <name>] [--project <name>] [--host <id>] [--all] [--json]',
    flags: [
      ['--project <name>', '只看这一个项目'],
      ['--host <id>', '只看这一台主机'],
      ['--all', '所有项目都看（不能与 --host 同用）'],
      ['--json', '输出 { host, project, releaseRoot, current, previous, releases, deployed, healthy, reason }'],
    ],
    examples: [
      'dp status --host local',
      'dp status --all --json',
      'dp status --project web --host web-01 --env prod',
    ],
    related: ['verify', 'facts', 'rollback'],
    commonErrors: [
      ['DP.SSH.CONNECT_FAILED', '连不上目标机；确认网络 / 凭据 / 端口，或改用 --host 本机'],
      ['DP.PATH.NOT_WRITABLE', '发布根算不出来；用 release.root 显式指定，或让运维授权候选之一'],
    ],
    implemented: true,
  },
]

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name)

export function findCommand(name: string): CommandDoc | undefined {
  return COMMANDS.find((c) => c.name === name)
}

/** 最相近命令建议。纯函数：编辑距离足够，不需要引任何库 */
export function editDistance(a: string, b: string): number {
  const rows = a.length
  const cols = b.length
  let prev = Array.from({ length: cols + 1 }, (_, i) => i)
  for (let r = 1; r <= rows; r += 1) {
    const cur = [r, ...Array<number>(cols).fill(0)]
    for (let c = 1; c <= cols; c += 1) {
      const cost = a[r - 1] === b[c - 1] ? 0 : 1
      cur[c] = Math.min((prev[c] as number) + 1, (cur[c - 1] as number) + 1, (prev[c - 1] as number) + cost)
    }
    prev = cur
  }
  return prev[cols] as number
}

/**
 * 未找到命令时给最相近的那个。阈值取「长度的一半取整」—— 再远就没有参考价值了，
 * 硬凑一个不像的建议比不给更糟（用户会以为那就是对的）。
 */
export function suggestCommand(name: string, candidates: readonly string[] = COMMAND_NAMES): string | undefined {
  let best: string | undefined
  let bestDistance = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const d = editDistance(name, candidate)
    if (d < bestDistance) {
      bestDistance = d
      best = candidate
    }
  }
  const threshold = Math.max(1, Math.floor(name.length / 2))
  return best !== undefined && bestDistance <= threshold ? best : undefined
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function renderTable(rows: readonly (readonly [string, string])[]): string[] {
  const width = rows.reduce((max, [left]) => Math.max(max, left.length), 0)
  return rows.map(([left, right]) => `  ${pad(left, width)}  ${right}`)
}

export function rootHelp(version: string): string {
  const done = COMMANDS.filter((c) => c.implemented)
  const todo = COMMANDS.filter((c) => !c.implemented)
  return [
    `dp ${version} —— deploy-kit 命令行。把目录/文件通过 rsync / scp / ssh 部署到本地或远端；`,
    '发布根由实证能力推导，切换 current 走 rename 保证原子。',
    '',
    '用法',
    '  dp <命令> [选项]',
    '',
    '命令（已实现）',
    ...renderTable(done.map((c) => [c.name, c.summary] as const)),
    '',
    '命令（后续回合接入，现在会明确拒绝而不是静默什么都不做）',
    ...renderTable(todo.map((c) => [c.name, c.summary] as const)),
    '',
    '全局开关',
    ...renderTable(GLOBAL_FLAGS),
    '',
    '例子（可直接复制）',
    '  dp plan --project web --host local',
    '  dp facts --host local --json > .tmp/facts.json',
    '  dp schema --out ./deploy.schema.json',
    '',
    '退出码',
    ...EXIT_CODE_ROWS.map(([code, meaning]) => `  ${code}  ${meaning}`),
    '',
    '配置发现优先级：-c/--config > 环境变量 DP_CONFIG > 自动发现',
    '（deploy.config.ts | deploy.config.js | deploy.config.json，从当前目录向上冒泡到 git 根）。',
    '给了 -c 又自动发现到别的文件时会明确报错，不静默选一个。',
    '',
    '更多：`dp help <命令>` 或 `dp <命令> --help`。',
  ].join('\n')
}

export function commandHelp(doc: CommandDoc): string {
  const lines = [
    `dp ${doc.name} —— ${doc.summary}`,
    '',
    '用法',
    `  ${doc.usage}`,
    '',
    '专属开关',
    ...(doc.flags.length > 0 ? renderTable(doc.flags) : ['  （无，全部用全局开关）']),
    '',
    '全局开关',
    ...renderTable(GLOBAL_FLAGS),
    '',
    '例子（可直接复制）',
    ...doc.examples.map((e) => `  ${e}`),
    '',
    `相关命令`,
    `  ${doc.related.length > 0 ? doc.related.join(' · ') : '（无）'}`,
  ]
  if (doc.commonErrors.length > 0) {
    lines.push('', '常见错误', ...doc.commonErrors.map(([code, fix]) => `  ${pad(code === '' ? '（未实现）' : code, 24)}  ${fix}`))
  }
  lines.push('', `退出码：${EXIT_CODE_ROWS.map(([c, m]) => `${c}=${m}`).join(' / ')}`)
  return lines.join('\n')
}

export function unknownCommandMessage(name: string): string {
  const suggestion = suggestCommand(name)
  const lines = [`未知命令：${name}`]
  if (suggestion !== undefined) {
    lines.push(`  你是不是想用：dp ${suggestion}（跑 \`dp help ${suggestion}\` 看用法）`)
  }
  lines.push('  可用命令：' + COMMAND_NAMES.join(' | '))
  lines.push('  用 `dp --help` 看全部说明')
  return lines.join('\n')
}

export function notImplementedMessage(doc: CommandDoc): string {
  return [
    `dp ${doc.name} 还没接入（后续回合实现）。`,
    '本回合这条命令会打印这句并以退出码 1 结束 —— 不会静默什么都不做，',
    '因为「静默成功」是自动化里最难查的一类故障。',
    '现在能做的：dp plan --host <id> —— 先看清将要执行哪些步骤。',
  ].join('\n')
}
