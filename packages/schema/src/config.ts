/**
 * 配置结构定义 + define* 辅助。
 *
 * 第 4 条要求：每个配置段都提供独立的 define*，便于同文件/多文件内提示与复用。
 * define* 的参数类型是**用户可写**的形态（InputOf），返回归一化后的类型（Infer）。
 */
import { DpError } from '@dp/ports'
import {
  arr,
  bool,
  constrained,
  literal,
  num,
  obj,
  oneOf,
  opt,
  prefChain,
  record,
  str,
  withDefault,
  type Infer,
  type InputOf,
  type JsonSchemaNode,
  type Schema,
} from './dsl.js'

// ============================================================
// 联合
// ============================================================

/**
 * 对象 / 数组这类联合。
 *
 * 为什么不用 `oneOf`：它只认字符串枚举，对象联合无处可挂（枚举里放不进"对象或对象数组"）。
 * 为什么不让它「逐个试、谁先过算谁的」：试错式分派要靠**异常**探测，
 * 而两个分支都失败时报哪个错，取决于抛出顺序 —— 用户看到的是随机的措辞，
 * 下次换个写法又变一句话。这里要求每个分支自带一个**形状判据**，判据不匹配就直接说清
 * 期望的两种形态，错误消息与输入无关。
 *
 * 这是本文件内部用的最小实现，不进 dsl：它是「两个已有 schema 的组合」，
 * 而不是第四种类型。真的需要第四种时再往上提。
 */
function unionOf<AOut, AIn, BOut, BIn>(
  a: { readonly schema: Schema<AOut, AIn, false>; readonly matches: (input: unknown) => boolean; readonly shape: string },
  b: { readonly schema: Schema<BOut, BIn, false>; readonly matches: (input: unknown) => boolean; readonly shape: string },
): Schema<AOut | BOut, AIn | BIn, false> {
  return {
    kind: 'union',
    isOptional: false,
    acceptsUndefined: false,
    parse(input, path) {
      if (a.matches(input)) return a.schema.parse(input, path)
      if (b.matches(input)) return b.schema.parse(input, path)
      throw new DpError('CONFIG_INVALID', `期望 ${a.shape} 或 ${b.shape}，实际是 ${describe(input)}`, {
        path,
        hint: `两种写法都可以：${a.shape}；${b.shape}`,
      })
    },
    toJsonSchema: () => ({ anyOf: [a.schema.toJsonSchema(), b.schema.toJsonSchema()] } as JsonSchemaNode),
  }
}

function describe(input: unknown): string {
  if (input === null) return 'null'
  if (Array.isArray(input)) return 'array'
  return typeof input
}

const isArray = (input: unknown): boolean => Array.isArray(input)
const isPlainObject = (input: unknown): boolean => typeof input === 'object' && input !== null && !Array.isArray(input)
const isFalse = (input: unknown): boolean => input === false


// ============================================================
// 源
// ============================================================

/**
 * 第 15 条：`./dist` 与 `./dist/**` 必须无歧义。
 *
 *  - `./dist`     → 目录**本身**
 *  - `./dist/**`  → 目录**内容**
 *  - `./dist/`    → **报错**：歧义靠拒绝解决，不靠默认值猜
 */
const sourceRoot = constrained(
  str('源路径。"./dist" = 目录本身；"./dist/**" = 目录内容'),
  (value, path) => {
    if (/[\\/]$/.test(value)) {
      throw new DpError(
        'CONFIG_INVALID',
        `源路径以分隔符结尾，语义有歧义：${value}`,
        {
          path,
          hint: `写 "${value.slice(0, -1)}" 表示目录本身，写 "${value}**" 表示目录内容`,
        },
      )
    }
  },
)

export const sourceSchema = obj(
  {
    root: sourceRoot,
    include: opt(arr(str('包含模式'))),
    exclude: opt(arr(str('排除模式'))),
  },
  '部署源',
)

// ============================================================
// 主机：连接 / 提权 / 布局 / 传输
// ============================================================

export const becomeSchema = obj(
  {
    type: withDefault(oneOf(['none', 'sudo', 'su', 'doas', 'custom'] as const), 'none'),
    user: opt(str('提权到哪个用户')),
    method: withDefault(oneOf(['auto', 'nopasswd', 'stdin', 'pty'] as const), 'auto'),
    passwordRef: opt(str('凭据引用，如 env:SUDO_PASSWORD —— 绝不直接写密码')),
    preserveEnv: withDefault(bool(), false),
  },
  '提权方式。type: none = 纯普通用户，同样是一等公民',
)

export const TRANSPORT_KINDS = ['rsync', 'tar-ssh', 'sftp', 'scp', 'local'] as const
export const DEFAULT_TRANSPORT_CHAIN = ['rsync', 'tar-ssh', 'sftp', 'scp'] as const

export const transportSchema = obj(
  {
    strategy: withDefault(prefChain(TRANSPORT_KINDS, DEFAULT_TRANSPORT_CHAIN), DEFAULT_TRANSPORT_CHAIN),
    delete: withDefault(bool('删除目标上源里没有的文件。默认 false'), false),
    compress: withDefault(oneOf(['auto', 'none', 'gzip', 'zstd'] as const), 'auto'),
  },
  '传输偏好链：按顺序尝试，都不支持则报 DP.PREF.UNSUPPORTED',
)

export const hostSchema = obj(
  {
    ssh: opt(str('user@host[:port]')),
    local: opt(bool('本机目标')),
    become: opt(becomeSchema),
    layout: withDefault(
      oneOf(['auto', 'system', 'user'] as const),
      'auto',
    ),
    transport: opt(transportSchema),
  },
  '一台目标主机。路径不写在这里 —— 由能力推导（docs/privilege.md）',
)

// ============================================================
// 目标
// ============================================================

export const TARGET_KINDS = ['static', 'nginx', 'docker', 'systemd', 'process'] as const

/**
 * nginx 段。**只管形状与类型**，语义判定全部留给 @dp/target-nginx。
 *
 * `proxy.upstream` 的末尾斜杠、`locations: []`、`listen` 的修饰符这些判定在渲染层
 * 都已经有了，还带 hint。在这里再写一遍就是两套规则各自演化，症状是「CLI 说合法、
 * 渲染时报错」或反过来 —— 所以本段刻意不知道它们。
 *
 * 唯一的例外是 reload 里的**空串**：那是纯类型层看不出来的（`['']` 类型上完全合法），
 * 而空参数会让目标机的 execve 直接失败，报错还与真正的问题无关。渲染层也会拒它，
 * 但那要等到真部署时；配置加载就拒掉是更便宜的一处。
 */
const proxyTimeoutsSchema = obj(
  {
    connect: opt(num('connect 超时，秒')),
    send: opt(num('send 超时，秒')),
    read: opt(num('read 超时，秒')),
  },
  '反代超时，单位秒',
)

const reverseProxySchema = obj(
  {
    upstream: str('后端地址，如 http://127.0.0.1:8080'),
    websocket: opt(bool('走 Upgrade/Connection 头。需要主配置里有 map $http_upgrade $connection_upgrade')),
    timeouts: opt(proxyTimeoutsSchema),
  },
  '反代',
)

const locationSchema = obj(
  {
    path: str('location 匹配串，如 /、/api/、= /healthz、~ \\.php$'),
    root: opt(str('相对 server 的 root 覆盖')),
    tryFiles: opt(str('try_files 参数，如 $uri $uri/ /index.html')),
    proxy: opt(reverseProxySchema),
    extra: opt(arr(str('原样输出的附加指令'))),
  },
  '一个 location',
)

const serverBlockSchema = obj(
  {
    serverName: opt(arr(str('server_name。省略 = 不按域名分流，渲染成 server_name _'))),
    listen: opt(arr(unionOf<number, number, string, string>(
      { schema: num('端口'), matches: (v) => typeof v === 'number', shape: '数字端口' },
      { schema: str('带修饰符的监听地址，如 "443 ssl"'), matches: (v) => typeof v === 'string', shape: '带修饰符的字符串' },
    ))),
    root: opt(str('静态根，通常是 ${release.current}（软链）而不是具体版本目录')),
    index: opt(arr(str('index 指令'))),
    locations: opt(arr(locationSchema)),
    reverseProxy: opt(reverseProxySchema),
    extra: opt(arr(str('原样输出的附加指令'))),
  },
  '一个 server 块',
)

const reloadSchema = unionOf<readonly string[], readonly string[], false, false>(
  {
    schema: constrained(arr(str('reload 命令的 argv')), (value, path) => {
      for (let i = 0; i < value.length; i += 1) {
        if (value[i] === '') {
          throw new DpError('CONFIG_INVALID', 'reload 的参数里有空串', {
            path: `${path}[${i}]`,
            hint: '删掉空串。空参数会让目标机的 execve 直接失败，报错还与真正的问题无关',
          })
        }
      }
    }),
    matches: isArray,
    shape: 'argv 数组',
  },
  { schema: literal(false), matches: isFalse, shape: 'false（由外部机制重载）' },
)

export const nginxSchema = obj(
  {
    server: unionOf(
      { schema: serverBlockSchema, matches: isPlainObject, shape: '单个 server 块对象' },
      { schema: arr(serverBlockSchema), matches: isArray, shape: 'server 块数组' },
    ),
    filename: opt(str('confd 里的文件名，不含目录。默认 <项目名>.conf')),
    force: opt(bool('覆盖未带 `# managed by dp` 的同名文件（仍先备份）')),
    reload: opt(reloadSchema),
  },
  'nginx 目标。confd 不是这里的字段 —— 它在 target.confd，默认由实测能力推导',
)

export const targetSchema = obj(
  {
    type: prefChain(TARGET_KINDS, ['static'] as const, '目标类型，也可以是偏好链'),
    pick: withDefault(oneOf(['auto', 'fail'] as const), 'auto'),
    confd: opt(str('conf.d 目录（nginx 目标）。不写则由实测能力推导')),
    service: opt(str('服务名（systemd / process 目标）')),
    nginx: opt(nginxSchema),
  },
  '部署目标',
)

// ============================================================
// 发布
// ============================================================

export const releaseSchema = obj(
  {
    root: opt(str('发布根目录。不写则由能力推导，见 docs/privilege.md §6')),
    keep: withDefault(num('保留的历史版本数'), 5),
    shared: opt(arr(str('跨版本共享的相对路径，如 uploads'))),
    owner: opt(str('属主')),
    dirMode: opt(str('目录权限，如 0750')),
    fileMode: opt(str('文件权限，如 0640')),
    switchStrategy: withDefault(
      oneOf(['auto', 'symlink', 'rename', 'copy'] as const),
      'auto',
    ),
  },
  '发布布局',
)

export const activationSchema = obj(
  {
    mode: withDefault(oneOf(['trial-promote', 'direct'] as const), 'trial-promote'),
    trialTimeout: withDefault(str('trial 未 promote 的超时'), '10m'),
    autoPromote: withDefault(
      oneOf(['when-healthcheck-passes', 'never', 'always'] as const),
      'when-healthcheck-passes',
    ),
    promoteConsecutivePasses: withDefault(num('连续通过次数'), 3),
    promoteWindow: withDefault(str('通过次数必须落在的时间窗'), '30s'),
  },
  '两阶段激活。没有 healthcheck 时 when-healthcheck-passes 退化为 never',
)

// ============================================================
// 项目与配置根
// ============================================================

export const healthcheckSchema = obj(
  {
    command: opt(str('执行的命令，退出码 0 视为健康')),
    http: opt(
      obj({
        path: str('请求路径'),
        expectStatus: withDefault(num('期望状态码'), 200),
        port: opt(num()),
      }),
    ),
    tcp: opt(obj({ port: num('端口') })),
    /**
     * 激活后必须存在的相对路径。static 目标的主要校验手段 ——
     * 它不需要起任何进程，也不用碰 shell，是最省资源的一种健康检查。
     */
    fileExists: opt(arr(str('release 目录中必须存在的相对路径'))),
    timeoutMs: withDefault(num('单次超时'), 5000),
    intervalMs: withDefault(num('轮询间隔'), 2000),
  },
  '健康检查。它的有无决定 autoPromote 能否生效',
)

export const projectSchema = obj(
  {
    source: sourceSchema,
    hosts: opt(arr(str('引用的主机名'))),
    release: opt(releaseSchema),
    target: opt(targetSchema),
    build: opt(
      obj({
        command: opt(str('构建命令')),
        where: withDefault(oneOf(['local', 'remote'] as const), 'local'),
        artifact: opt(str('产物路径')),
      }),
    ),
    healthcheck: opt(healthcheckSchema),
    activation: opt(activationSchema),
    transport: opt(transportSchema),
  },
  '一个可部署的项目',
)

export const configSchema = obj(
  {
    defaults: opt(
      obj({
        hosts: opt(record(hostSchema)),
        release: opt(releaseSchema),
        transport: opt(transportSchema),
        activation: opt(activationSchema),
      }),
    ),
    hosts: opt(record(hostSchema)),
    projects: record(projectSchema),
    profiles: opt(
      record(
        obj({
          hosts: opt(record(hostSchema)),
          release: opt(releaseSchema),
          transport: opt(transportSchema),
          activation: opt(activationSchema),
        }),
        '环境档案（dev / staging / prod）',
      ),
    ),
  },
  'deploy-kit 配置根',
)

// ============================================================
// define* —— 每段一个，便于分段复用与类型提示
// ============================================================

export type Config = Infer<typeof configSchema>
export type ConfigInput = InputOf<typeof configSchema>
export type HostConfig = Infer<typeof hostSchema>
export type HostInput = InputOf<typeof hostSchema>
export type ProjectConfig = Infer<typeof projectSchema>
export type ProjectInput = InputOf<typeof projectSchema>
export type SourceConfig = Infer<typeof sourceSchema>
export type ReleaseConfig = Infer<typeof releaseSchema>
export type TargetConfig = Infer<typeof targetSchema>
export type NginxConfig = Infer<typeof nginxSchema>
export type NginxInput = InputOf<typeof nginxSchema>
export type TransportConfig = Infer<typeof transportSchema>
export type ActivationConfig = Infer<typeof activationSchema>
export type HealthcheckConfig = Infer<typeof healthcheckSchema>
export type BecomeConfig = Infer<typeof becomeSchema>

export const defineConfig = (c: ConfigInput): Config => configSchema.parse(c, 'config')
export const defineHost = (c: HostInput): HostConfig => hostSchema.parse(c, 'host')
export const defineProject = (c: ProjectInput): ProjectConfig => projectSchema.parse(c, 'project')
export const defineSource = (c: InputOf<typeof sourceSchema>): SourceConfig =>
  sourceSchema.parse(c, 'source')
export const defineRelease = (c: InputOf<typeof releaseSchema>): ReleaseConfig =>
  releaseSchema.parse(c, 'release')
export const defineTarget = (c: InputOf<typeof targetSchema>): TargetConfig =>
  targetSchema.parse(c, 'target')
export const defineNginx = (c: NginxInput): NginxConfig => nginxSchema.parse(c, 'nginx')
export const defineTransport = (c: InputOf<typeof transportSchema>): TransportConfig =>
  transportSchema.parse(c, 'transport')
export const defineActivation = (c: InputOf<typeof activationSchema>): ActivationConfig =>
  activationSchema.parse(c, 'activation')
export const defineHealthcheck = (c: InputOf<typeof healthcheckSchema>): HealthcheckConfig =>
  healthcheckSchema.parse(c, 'healthcheck')
export const defineBecome = (c: InputOf<typeof becomeSchema>): BecomeConfig =>
  becomeSchema.parse(c, 'become')

/** 导出 JSON Schema，供编辑器提示 / 校验使用 */
export const configJsonSchema = (): ReturnType<typeof configSchema.toJsonSchema> =>
  configSchema.toJsonSchema()
