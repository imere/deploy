/**
 * 配置结构定义 + define* 辅助。
 *
 * 第 4 条要求：每个配置段都提供独立的 define*，便于同文件/多文件内提示与复用。
 * define* 的参数类型是**用户可写**的形态（InputOf），返回归一化后的类型（Infer）。
 */
import { DpError, KNOWN_HOSTS_MODES, assertPortInRange, parseSshTarget } from '@dp/ports'
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
      throw new DpError('DP.CONFIG.INVALID', `期望 ${a.shape} 或 ${b.shape}，实际是 ${describe(input)}`, {
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
        'DP.CONFIG.INVALID',
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

/** 逐跳的认证方式。只认非交互来源 —— 交互式认证在任何一层都拿不到输入 */
const hopAuthSchema = obj(
  {
    type: withDefault(oneOf(['key', 'agent'] as const), 'agent'),
    identityFile: opt(str('私钥路径')),
  },
  '逐跳认证。多跳只支持 key / agent：`-J` 无法逐跳喂密码',
)

/**
 * 一跳。`ssh` 用 `user@host[:port]` 串，`port` 字段是它的显式覆盖。
 *
 * 端口**同时**接受两种写法是有代价的，所以这里只允许一种：串里写了端口就以串为准，
 * 串与 `port` 字段同时给出且不一致时报错而不是二选一 —— 静默取一个会让用户
 * 以为连的是自己写的那台。
 */
export const hopSchema = constrained(
  obj(
    {
      ssh: str('user@host[:port]'),
      auth: opt(hopAuthSchema),
      knownHosts: opt(oneOf(KNOWN_HOSTS_MODES, '这一跳的主机密钥策略')),
      port: opt(num('端口，1–65535')),
    },
    '多跳链上的一跳',
  ),
  (value, path) => {
    const target = parseSshTarget(value.ssh, `${path}.ssh`)
    if (value.port === undefined) return
    assertPortInRange(value.port, `${path}.port`)
    if (target.port !== undefined && target.port !== value.port) {
      throw new DpError(
        'DP.CONFIG.INVALID',
        `这一跳给了两个互相矛盾的端口：ssh 串里是 ${target.port}，port 字段是 ${value.port}`,
        {
          path: `${path}.port`,
          hint: '留一个就行。写 ssh: user@host:2222 就不要再写 port；port 字段是给「串里不带端口」的场景用的',
        },
      )
    }
  },
)

/**
 * 一台目标机。连接方式三选一：ssh（单跳）/ hops（多跳）/ local（本机）。
 *
 * 为什么不提供「都写」的合并语义：两条连接路径同时存在时，没有任何规则能说清
 * 该走哪条，而走错的后果是部署到了另一台机器上 —— 报错比连错便宜得多。
 *
 * `layout` 是显式选择而不是配置项：auto 之外三个值决定发布根落在哪，
 * 而那是「用户想让服务出现在哪」的决定，不是能力探测能替用户做的。
 */
export const hostSchema = constrained(
  obj(
    {
      ssh: opt(str('user@host[:port]')),
      hops: opt(arr(hopSchema, '多跳跳板链，从第一跳到最终目标依次排列')),
      local: opt(bool('本机目标')),
      become: opt(becomeSchema),
      layout: withDefault(
        oneOf(['auto', 'system', 'user'] as const),
        'auto',
      ),
      transport: opt(transportSchema),
    },
    '一台目标主机。路径不写在这里 —— 由能力推导',
  ),
  (value, path) => {
    // 空数组按「没给」处理：hops: [] 与不写 hops 是同一件事，报「0 跳」只会让人
    // 去查一个根本不存在的问题
    const hopsGiven = value.hops !== undefined && value.hops.length > 0
    if (value.ssh !== undefined && hopsGiven) {
      throw new DpError('DP.CONFIG.INVALID', 'ssh 与 hops 同时给了，二者只能选一个', {
        path: `${path}.ssh`,
        hint: '二选一：单跳写 ssh: user@host[:port]；多跳把整条链写进 hops（最后一跳就是目标机）。想同时表达会得到两条互相矛盾的连接路径',
      })
    }
  },
)

// ============================================================
// 目标
// ============================================================

/**
 * 目标类型全集。**全仓只有这一份**。
 *
 * 与 `@dp/core` 探测层的候选表刻意不同：那里只有**已实现执行器**的类型
 * （systemd / process 还没有），而这里必须列全，否则用户写了个合法的
 * systemd 目标却在 schema 层被拒 —— 那时报错指向配置，而问题在能力缺失。
 * 两层各写一份的漂移风险由探测层那份显式声明不等来接。
 */
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
          throw new DpError('DP.CONFIG.INVALID', 'reload 的参数里有空串', {
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

/**
 * nginx 目标。**只管形状与类型**，语义判定全部留给 `@dp/target-nginx`。
 *
 * 唯一在这里就拒的是 reload 里的空串：纯类型层看不出来（`['']` 完全合法），
 * 而空参数会让目标机的 execve 失败、报错还与真正的问题无关。配置加载就拒
 * 比等到真部署时再拒便宜 —— 后者已经动过生产路径了。
 */
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

/**
 * docker 段。**只管形状与类型**，语义判定全部留给 @dp/target-docker。
 *
 * 与 nginx 段同一条纪律，两套规则各自演化的症状是「CLI 说合法、执行时报错」或反过来：
 *  - 绝对路径 / `..` / 反斜杠 / 重复文件 → `DP.DOCKER.COMPOSE_FILE_*`（compose.ts）
 *  - projectName 的字符集 → `DP.DOCKER.PROJECT_NAME_INVALID`（compose.ts）
 *  - `files: []` → `DP.DOCKER.COMPOSE_FILES_EMPTY`（compose.ts）
 *  - 非 `remote-cli` 的 mode → `DP.DOCKER.MODE_UNSUPPORTED`（compose.ts）
 *
 * 唯一的例外是 `compose.files` 元素里的**空串**，理由与 reload 那条一致：
 * 类型上 `['']` 完全合法，而空路径拼进 `-f` 后面在目标机上报的是一句与本次部署
 * 毫无关系的话（`no such file or directory`，指向那个空路径）。配置加载就拒掉是
 * 更便宜的一处。
 */
const composeFilesSchema = constrained(
  arr(str('compose 文件路径，相对 release 目录，按给定顺序生效')),
  (value, path) => {
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] === '') {
        throw new DpError('DP.CONFIG.INVALID', 'compose.files 的元素里有空串', {
          path: `${path}[${i}]`,
          hint:
            '删掉这个空串。空路径拼进 `-f` 后面，目标机报的是 `no such file or directory`，' +
            '指向那个空路径而不是你真正想指的那一处',
        })
      }
    }
  },
)

const dockerComposeSchema = obj(
  {
    // 必填：空数组在 schema 层合法（用户可能用数组拼装），但它的后果是
    // 「不带 -f 的 docker compose up 会去当前工作目录找文件」—— 那条错误信息
    // 属于 compose.ts 的 DP.DOCKER.COMPOSE_FILES_EMPTY，hint 里带着这句解释
    files: composeFilesSchema,
    projectName: str('compose -p 的值：容器名与网络名的前缀'),
    envFile: opt(str('env 文件路径，相对 release 目录。给了就变成 --env-file')),
    pull: withDefault(bool('拉取镜像。浮动 tag 不 pull 等于部署上一轮的镜像'), true),
    wait: withDefault(bool('up --wait 等到健康。关掉后 verify 是唯一一道关'), true),
  },
  'compose 配置。发布根目录不是这里的字段 —— 它由能力推导',
)

const dockerHealthcheckSchema = obj(
  {
    services: opt(arr(str('只检查这些服务。不写 = ps 输出里每个服务都要通过'))),
    expectStates: opt(arr(str('期望状态。默认 running / healthy'))),
  },
  'docker 健康检查。它的有无决定哪些服务算数',
)

/**
 * docker 目标。**只管形状与类型**，语义判定全部留给 `@dp/target-docker`。
 *
 * 与 nginx 段同一条纪律：compose.files 的路径合法性、projectName 的字符集、
 * `files: []` 这些都归执行器判，schema 层重复一遍的结果是「CLI 说合法、
 * 执行时报错」。只有空串元素在这里拒，理由与 reload 那条一致。
 */
export const dockerSchema = obj(
  {
    mode: withDefault(oneOf(['remote-cli'] as const), 'remote-cli'),
    compose: dockerComposeSchema,
    healthcheck: opt(dockerHealthcheckSchema),
  },
  'docker 目标。本轮只实现 remote-cli：compose 文件随 release 上传后在目标机上跑',
)

/**
 * 多目标类型同时命中时怎么选。**全仓只有这一份**。
 *
 * `fail` 之外的唯一选项是 `auto`（取 confidence 最高，最高分并列照样报错）。
 * 默认值定在这里，因为它是归一化层的职责：`dp deploy` 的零配置路径也引用它，
 * 否则「有配置文件时用 auto、零配置时用 fail」就成了同一件事两套规则。
 */
export const DEFAULT_TARGET_PICK = 'auto'

/**
 * 部署目标。type 收窄了 `nginx` / `docker` 两段与 type 的一致性 ——
 * 写 `type: 'nginx'` 却给了 docker 段，在这一层就能拒。
 *
 * confd 刻意**不是**这里的必填项：它是实测能力的结论（同 platform 下
 * 多个候选目录可能只有一个可写），让用户填等于把探测结果提前猜死。
 */
export const targetSchema = obj(
  {
    type: prefChain(TARGET_KINDS, ['static'] as const, '目标类型，也可以是偏好链'),
    pick: withDefault(oneOf(['auto', 'fail'] as const), DEFAULT_TARGET_PICK),
    confd: opt(str('conf.d 目录（nginx 目标）。不写则由实测能力推导')),
    service: opt(str('服务名（systemd / process 目标）')),
    nginx: opt(nginxSchema),
    docker: opt(dockerSchema),
  },
  '部署目标',
)

// ============================================================
// 发布
// ============================================================

/**
 * 保留几个历史版本。**全仓只有这一份**。
 *
 * 之前它有三处：这里的 `withDefault`、`@dp/core` 的 `?? 5`、`@dp/cli` 的 `DEFAULT_KEEP`。
 * 三处同值是巧合而不是约束 —— 改一处漏两处的结果是「plan 说保留 10 个、
 * 实际 prune 只留 5 个」，且两边都不报错。默认值属于归一化层（schema），
 * 其余各处引用它。
 */
export const DEFAULT_KEEP = 5

/**
 * 发布布局。root 缺省时由能力推导，不要求用户给绝对路径 ——
 * 同一份配置要能在开发机与目标机上都成立。
 *
 * dirMode / fileMode 用字符串（'0750'）而不是数字：配置文件的数字字面量
 * 会被读成十进制，写 `0750` 的用户以为自己在写八进制，而结果是权限错到
 * 服务起不来才暴露。字符串形态让「这是八进制」这件事显式化。
 */
export const releaseSchema = obj(
  {
    root: opt(str('发布根目录。不写则由能力推导')),
    keep: withDefault(num('保留的历史版本数'), DEFAULT_KEEP),
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

/**
 * 两阶段激活。默认 trial→promote：先起新版本、验过再切流量。
 *
 * 为什么不默认 direct：新版本在验过之前就接流量的失败模式是「用户看到的是
 * 半死的服务」，而那种现场没法在事后还原。默认走慢的那条，是为了让默认
 * 配置下永远不出现不可诊断的故障。
 *
 * trialTimeout / promoteWindow 是**时长字符串**（'10m'）而不是秒数：
 * 配置是人写的，`'10m'` 与 `600` 的意图差别在读的人心里，不在机器里。
 */
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

/**
 * 健康检查。**它的有无**决定 autoPromote 能否生效：没有 healthcheck 时
 * `when-healthcheck-passes` 退化为 never，而不是「没人检查就当通过」。
 *
 * 默认的那次是「直接通过」还是「真的通过」决定语义，所以退化方向只能是
 * 保守的一侧 —— 自动放行一个没验过的版本，等于把 trial 阶段的意义拿掉。
 *
 * fileExists 是 static 目标的主要手段：它不需要起进程、不碰 shell，
 * 是唯一在只有文件权限的目标机上也能跑的检查。
 */
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

/**
 * 一个可部署的项目。source 必填而 target 缺省：
 * 目标可以完全由探测得出（零配置路径的前提），源不行 ——
 * 「部署什么」是用户的事，「部署到哪、怎么部署」大多可以问机器。
 */
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

/**
 * 配置根。`defaults` 与 `profiles` 是同一组段的两种复用方式，
 * 优先级由 `@dp/core` 合成阶段定，schema 层不判先后 ——
 * 合并语义只有一处，判两次的结果是两边对同一份配置给出不同答案。
 *
 * projects 必填：空配置没有任何可部署对象，报错比展开成「0 个项目」有用。
 */
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

/** 归一化后的配置。默认值已填齐 —— 下游不必再判「用户写没写」 */
export type Config = Infer<typeof configSchema>
/**
 * 用户可写的配置形态。可省字段在这里仍是可选的，偏好链可以写单值。
 *
 * Config / Input 分成两个类型而不是一个：前者是「拿到的」，后者是「写下的」。
 * 合成一个的结果是默认值既看起来可省又必填，IDE 提示会自相矛盾。
 */
export type ConfigInput = InputOf<typeof configSchema>
/** 归一化后的一台主机，ssh / hops / local 三选一已成立 */
export type HostConfig = Infer<typeof hostSchema>
/** 主机段的可写形态，ssh / hops 可以省略（local 目标除外） */
export type HostInput = InputOf<typeof hostSchema>
/** 归一化后的项目段 */
export type ProjectConfig = Infer<typeof projectSchema>
/** 项目段的可写形态 */
export type ProjectInput = InputOf<typeof projectSchema>
/** 归一化后的源段。root 不以分隔符结尾这件事已在 parse 时定死 */
export type SourceConfig = Infer<typeof sourceSchema>
/** 归一化后的发布段，keep 一定有值 */
export type ReleaseConfig = Infer<typeof releaseSchema>
/** 归一化后的目标段，type 恒为数组 */
export type TargetConfig = Infer<typeof targetSchema>
/** 归一化后的 nginx 段，server 恒为数组 */
export type NginxConfig = Infer<typeof nginxSchema>
/** nginx 段的可写形态，server 可写单对象或数组 */
export type NginxInput = InputOf<typeof nginxSchema>
/** 归一化后的 docker 段 */
export type DockerConfig = Infer<typeof dockerSchema>
/** docker 段的可写形态 */
export type DockerInput = InputOf<typeof dockerSchema>
/** 归一化后的传输段，strategy 为非空的偏好链数组 */
export type TransportConfig = Infer<typeof transportSchema>
/** 归一化后的激活段。trialTimeout / promoteWindow 仍是时长字符串 */
export type ActivationConfig = Infer<typeof activationSchema>
/** 归一化后的健康检查段，timeoutMs / intervalMs 一定有值 */
export type HealthcheckConfig = Infer<typeof healthcheckSchema>
/** 归一化后的提权段，type 一定有值（缺省 'none'，不是 undefined） */
export type BecomeConfig = Infer<typeof becomeSchema>

/**
 * 校验并归一化整份配置。
 *
 * 为什么不直接给用户 `Config` 类型：类型只在编译期存在，而配置文件是
 * 运行时的 JSON/JS 对象 —— 必填检查、默认值填充、偏好链展开都得真的跑一遍。
 * define* 存在的意义就是让「声明的形状」与「实际校验」是同一份 schema。
 *
 * @param c 用户写的配置，字段可省、偏好链可写单值
 * @returns 归一化后的配置：默认值已填、偏好链已是数组
 * @throws DpError 带配置路径的校验错误，如 `projects.web.source.root`
 */
export const defineConfig = (c: ConfigInput): Config => configSchema.parse(c, 'config')
/**
 * 归一化一段主机定义。
 *
 * 分段独立出口是为了让同一台主机能被多个项目引用而只写一次 ——
 * `defineHost` 的结果可以直接填进 `defaults.hosts`，不需要为它单独造一个函数。
 *
 * @param c 主机段原文，ssh / hops / local 三选一
 * @returns 归一化后的主机：hops 非空或不存在，二者必居其一
 * @throws DpError ssh 与 hops 同时给出，或端口不在 1–65535
 */
export const defineHost = (c: HostInput): HostConfig => hostSchema.parse(c, 'host')
/**
 * 归一化一个项目段。与 defineConfig 走的是同一份 schema，
 * 只是错误路径前缀不同（`project.*` vs `projects.<name>.*`）。
 *
 * @param c 项目段原文
 * @returns 归一化后的项目段
 * @throws DpError 带 `project.` 前缀路径的校验错误
 */
export const defineProject = (c: ProjectInput): ProjectConfig => projectSchema.parse(c, 'project')
/**
 * 归一化源路径段。
 *
 * `./dist` 与 `./dist/**` 必须无歧义，而 `./dist/` 两者都像 ——
 * 所以以分隔符结尾直接报错，不猜。猜错的后果是传了目录本身却当成内容
 * （部署出空目录）或反过来（把目标目录整个删掉），后者不可逆。
 *
 * @param c 源段原文
 * @returns 归一化后的源段
 * @throws DpError root 以分隔符结尾，或以 `../` 开头（会逃出项目目录）
 */
export const defineSource = (c: InputOf<typeof sourceSchema>): SourceConfig =>
  sourceSchema.parse(c, 'source')
/**
 * 归一化发布布局段。keep 的缺省在这一层就填上，
 * 下游读到的必是有效数字而不是「可能没有」。
 *
 * @param c 发布段原文
 * @returns 归一化后的发布段，keep 一定有值
 * @throws DpError keep 非正整数
 */
export const defineRelease = (c: InputOf<typeof releaseSchema>): ReleaseConfig =>
  releaseSchema.parse(c, 'release')
/**
 * 归一化目标段。type 的单值 / 数组写法在这里统一成数组，
 * pick 缺省时填 `DEFAULT_TARGET_PICK`。
 *
 * @param c 目标段原文
 * @returns 归一化后的目标段，type 为偏好链数组
 * @throws DpError type 不在 `TARGET_KINDS` 内，或 nginx / docker 段与 type 不一致
 */
export const defineTarget = (c: InputOf<typeof targetSchema>): TargetConfig =>
  targetSchema.parse(c, 'target')
/**
 * 归一化 nginx 段。server 的「单对象 / 对象数组」两种写法在这里分派，
 * 下游拿到的永远是数组 —— 分派逻辑只写一份。
 *
 * @param c nginx 段原文
 * @returns 归一化后的 nginx 段
 * @throws DpError reload 的 argv 里有空串元素
 */
export const defineNginx = (c: NginxInput): NginxConfig => nginxSchema.parse(c, 'nginx')
/**
 * 归一化 docker 段。
 *
 * @param c docker 段原文
 * @returns 归一化后的 docker 段
 * @throws DpError compose.files 的元素里有空串（空路径在目标机上报的错指向那个空路径）
 */
export const defineDocker = (c: DockerInput): DockerConfig => dockerSchema.parse(c, 'docker')
/**
 * 归一化传输段。strategy 缺省或写 `auto` 时展开成 `DEFAULT_TRANSPORT_CHAIN`，
 * 链全失败由 core 报 `DP.PREF.UNSUPPORTED`。
 *
 * @param c 传输段原文
 * @returns 归一化后的传输段，strategy 为非空数组
 * @throws DpError 链里有不在 `TRANSPORT_KINDS` 中的项，或链为空
 */
export const defineTransport = (c: InputOf<typeof transportSchema>): TransportConfig =>
  transportSchema.parse(c, 'transport')
/**
 * 归一化激活段。默认 trial→promote + `when-healthcheck-passes`。
 *
 * @param c 激活段原文
 * @returns 归一化后的激活段，时长仍是字符串（解析在消费层做一次）
 * @throws DpError mode / autoPromote 取值非法
 */
export const defineActivation = (c: InputOf<typeof activationSchema>): ActivationConfig =>
  activationSchema.parse(c, 'activation')
/**
 * 归一化健康检查段。timeoutMs / intervalMs 的缺省在这一层填上，
 * 轮询的「等多久、查一次」不被两处各写一份。
 *
 * @param c 健康检查段原文
 * @returns 归一化后的健康检查段
 * @throws DpError http 段缺 path，或 tcp 段缺 port
 */
export const defineHealthcheck = (c: InputOf<typeof healthcheckSchema>): HealthcheckConfig =>
  healthcheckSchema.parse(c, 'healthcheck')
/**
 * 归一化提权段。缺省是 `type: 'none'` 而不是「没配提权」——
 * 不提权是一等合法配置（容器里的普通用户），把它表示成 undefined
 * 会让每个消费点都要写一次「没配 = 不提权」的分支，而漏一处就等于
 * 对着普通用户去跑 sudo。
 *
 * @param c 提权段原文
 * @returns 归一化后的提权段
 * @throws DpError type / method 取值非法
 */
export const defineBecome = (c: InputOf<typeof becomeSchema>): BecomeConfig =>
  becomeSchema.parse(c, 'become')

/**
 * 导出 JSON Schema，供编辑器悬浮提示 / 外部校验工具使用。
 *
 * 刻意**不用于**运行时校验：它只是本包 `obj()` 结构的另一个投影，
 * 而投影与 parse 判定分家之后，两边会各自演化。真正做校验的只有 `parse`。
 *
 * @returns 配置根对应的 JSON Schema 节点树；required 由各段的 isOptional 反推
 */
export const configJsonSchema = (): ReturnType<typeof configSchema.toJsonSchema> =>
  configSchema.toJsonSchema()
