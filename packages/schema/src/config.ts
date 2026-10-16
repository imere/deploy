import {
  DpError,
  KNOWN_HOSTS_MODES,
  PROCESS_STOP_SIGNALS,
  SWITCH_STRATEGIES,
  SYSTEMD_RESTART_POLICIES,
  assertPortInRange,
  parseSshTarget,
} from '@dp/ports'
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

// 联合

/**
 * 对象 / 数组这类联合。
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


// 源

/**
 * 第 15 条：`./dist` 与 `./dist/**` 必须无歧义。
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

// 主机：连接 / 提权 / 布局 / 传输

export const becomeSchema = constrained(
  obj(
    {
      type: withDefault(oneOf(['none', 'sudo', 'su', 'doas', 'custom'] as const), 'none'),
      user: opt(str('提权到哪个用户')),
      method: withDefault(oneOf(['auto', 'nopasswd', 'stdin', 'pty'] as const), 'auto'),
      passwordRef: opt(str('凭据引用，如 env:SUDO_PASSWORD —— 绝不直接写密码')),
      preserveEnv: withDefault(bool(), false),
      template: opt(str('type=custom 的命令模板，必须含 ${cmd}')),
    },
    '提权方式。type: none = 纯普通用户，同样是一等公民',
  ),
  (value, path) => {
    if (value.type !== 'custom') {
      if (value.template !== undefined) {
        throw new DpError('DP.CONFIG.INVALID', `become.type=${value.type} 时写 template 不生效`, {
          path: `${path}.template`,
          hint: 'template 只有 type=custom 读得到。要自定义提权命令就把 type 改成 custom，或删掉 template',
        })
      }
      return
    }
    if (value.template === undefined || value.template.trim() === '') {
      throw new DpError('DP.CONFIG.INVALID', 'become.type=custom 必须写 template', {
        path: `${path}.template`,
        hint: '模板形如 `dzdo -u root ${cmd}`；${cmd} 是占位，运行时替换成被提权那条命令',
      })
    }
    if (!value.template.includes('${cmd}')) {
      throw new DpError('DP.CONFIG.INVALID', `become.template 缺少 \${cmd} 占位：${value.template}`, {
        path: `${path}.template`,
        hint: '没有占位的模板会把被提权的命令整条丢掉 —— 那表现成「提权成功了但什么都没发生」',
      })
    }
  },
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
 * 一台目标机。连接方式三选一：ssh（单跳）/ hops（多跳）/ local（本地）。
 */
export const hostSchema = constrained(
  obj(
    {
      ssh: opt(str('user@host[:port]')),
      hops: opt(arr(hopSchema, '多跳跳板链，从第一跳到最终目标依次排列')),
      local: opt(bool('本地目标')),
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
    const hopsGiven = value.hops !== undefined && value.hops.length > 0
    if (value.ssh !== undefined && hopsGiven) {
      throw new DpError('DP.CONFIG.INVALID', 'ssh 与 hops 同时给了，二者只能选一个', {
        path: `${path}.ssh`,
        hint: '二选一：单跳写 ssh: user@host[:port]；多跳把整条链写进 hops（最后一跳就是目标机）。想同时表达会得到两条互相矛盾的连接路径',
      })
    }
  },
)

// 目标

/**
 * 目标类型全集。**全仓只有这一份**，且只收**已实现**的那几种。
 *
 * 探测还能认出 caddy / k8s / pm2 等更多形态，但它们没有执行器；把它们放进这里
 * 等于允许用户写出一份「通过了校验、跑起来却是 static」的配置 —— 那比直接拒绝
 * 难查得多。未实现的形态由探测层显式报错（`IMPLEMENTED_KINDS`），不在这里留口子。
 *
 * 反过来，**写得出 `type: nginx` 却没有 `nginx` 段**也必须是错的：段才是执行器的
 * 判据，type 只是覆盖探测的开关。这两条一起由 `targetSchema` 的一致性判定钉住。
 */
export const TARGET_KINDS = ['static', 'nginx', 'docker', 'systemd', 'process'] as const

/**
 * nginx 段。**只管形状与类型**，语义判定全部留给 @dp/target-nginx。
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
 * 不能是空白的字符串。空白值与缺省值要能区分开 —— 空串若等价于缺省，
 * 「用户显式写了空」与「用户没写」就成了一回事，而这种歧义正是配置校验存在的理由。
 */
function nonBlank(label: string): Schema<string, string, false> {
  return constrained(str(label), (value, path) => {
    if (value.trim() !== '') return
    throw new DpError('DP.CONFIG.INVALID', `${label} 是空白字符串`, {
      path,
      hint: `删掉这个字段表示「用默认值」，写成空白表示「我要一个空的值」—— 后者在这里没有意义。${label} 不能为空`,
    })
  })
}

/**
 * systemd 目标。**只管形状与类型**，语义判定（unit 行是否安全、ExecStart 是否为空）
 * 全部留给 `@dp/target-systemd`。
 */
export const systemdSchema = obj(
  {
    /** 不含目录。默认 `<项目名>.service` */
    unit: opt(str('unit 文件名')),
    /** 由上层从 layout 推导后注入，不是用户随手填的相对路径 */
    unitDir: str('unit 目录，目标机绝对路径'),
    scope: withDefault(oneOf(['system', 'user'] as const), 'system'),
    description: opt(str('Description 的值')),
    execStart: nonBlank('execStart'),
    execReload: opt(str('ExecReload 的值')),
    workingDirectory: opt(str('WorkingDirectory 的值')),
    user: opt(str('User 的值')),
    group: opt(str('Group 的值')),
    environment: opt(record(str('环境变量的值'))),
    restart: withDefault(oneOf(SYSTEMD_RESTART_POLICIES), 'on-failure'),
    restartSec: opt(num('RestartSec 的值，秒')),
    after: opt(arr(str('After 的单元名'))),
    requires: opt(arr(str('Requires 的单元名'))),
    wantedBy: withDefault(str('WantedBy 的 target'), 'multi-user.target'),
    /** 逃生舱：原样输出，不做转义与校验 */
    extra: opt(arr(str('原样输出的 unit 行'))),
  },
  'systemd 目标。restart 默认 on-failure 而不是 always —— 正常退出不该被无限重启',
)

/**
 * process 目标。**自带极简进程管理**：pidfile 记 pid，停止走「先信号后强杀」。
 * 不接 pm2 / supervisord 一类外部进程管理器 —— 它们要进目标机的依赖清单，
 * 而「目标机没装 pm2」会在部署期被报成「打包漏了东西」。
 */
export const processSchema = obj(
  {
    /** argv[0]。不是一行 shell —— 它会被原样 exec，不经 shell 解释 */
    command: nonBlank('command'),
    args: opt(arr(str('启动命令的参数'))),
    /** 默认 current 软链（当前生效版本目录） */
    workingDirectory: opt(str('工作目录')),
    env: opt(record(str('环境变量的值'))),
    stopSignal: withDefault(oneOf(PROCESS_STOP_SIGNALS), 'SIGTERM'),
    /** 优雅期过后才强杀。它必须是个上限而不是「等它结束」 */
    stopTimeoutMs: withDefault(num('停止等待上限，毫秒'), 10_000),
    /** 相对**发布根目录** —— 激活时只读这一个位置，不跟着版本目录漂 */
    pidFile: opt(str('pidfile 路径')),
    stdoutLog: opt(str('stdout/stderr 落盘位置')),
  },
  'process 目标。pid 与日志落在发布根下的 .dp/，启动/停止脚本跟着版本目录走',
)

/**
 * 多目标类型同时命中时怎么选。**全仓只有这一份**。
 */
export const DEFAULT_TARGET_PICK = 'auto'

/** type 缺省时展开成的链。判别「用户有没有写 type」要靠它 */
const DEFAULT_TARGET_CHAIN: readonly string[] = ['static']

/**
 * 部署目标。**type 与 nginx / docker / systemd / process 各段必须一致**：真正决定
 * 跑哪个执行器的是段，type 只是覆盖探测的开关，两者分叉就会「点名 nginx、
 * 实际按 static 部署」。
 */
export const targetSchema = constrained(
  obj(
    {
      type: prefChain(TARGET_KINDS, ['static'] as const, '目标类型，也可以是偏好链'),
      pick: withDefault(oneOf(['auto', 'fail'] as const), DEFAULT_TARGET_PICK),
      confd: opt(str('conf.d 目录（nginx 目标）。不写则由实测能力推导')),
      nginx: opt(nginxSchema),
      docker: opt(dockerSchema),
      systemd: opt(systemdSchema),
      process: opt(processSchema),
    },
    '部署目标。段才是执行器的判据，type 只是覆盖探测的开关 —— 两者必须一致',
  ),
  (value, path) => {
    const chain = [...value.type]
    // 反向那条只在「用户真的写了 type」时判：type 缺省展开成 ['static']，而只给 docker 段
    // 不写 type 是合法写法 —— 段才是执行器的判据
    const explicit = !(
      chain.length === DEFAULT_TARGET_CHAIN.length && chain.every((k, i) => k === DEFAULT_TARGET_CHAIN[i])
    )
    for (const kind of ['nginx', 'docker', 'systemd', 'process'] as const) {
      if (chain.includes(kind) && value[kind] === undefined) {
        throw new DpError('DP.CONFIG.INVALID', `target.type 点名 ${kind} 却没有 ${kind} 段`, {
          path: `${path}.${kind}`,
          hint: `写上 projects.<项目>.target.${kind}，或把 ${kind} 从 type 里去掉 —— 没有段就没有可执行的东西，跑下去只会静默按 static 部署`,
        })
      }
      if (explicit && value[kind] !== undefined && !chain.includes(kind)) {
        throw new DpError('DP.CONFIG.INVALID', `给了 ${kind} 段，但 target.type 里没有 ${kind}`, {
          path: `${path}.type`,
          hint: `把 ${kind} 加进 type，或删掉这一段 —— 两者不一致时实际跑的是段对应的执行器，type 就成了骗人的标签`,
        })
      }
    }
  },
)

// 发布

/**
 * 保留几个历史版本。**全仓只有这一份**。
 */
export const DEFAULT_KEEP = 5

/**
 * 发布布局。root 缺省时由能力推导，不要求用户给绝对路径 ——同一份配置要能在开发机与目标机上都成立。
 */
export const releaseSchema = obj(
  {
    root: opt(str('发布根目录。不写则由能力推导')),
    keep: withDefault(num('保留的历史版本数'), DEFAULT_KEEP),
    shared: opt(arr(str('跨版本共享的相对路径，如 uploads'))),
    owner: opt(str('属主')),
    dirMode: opt(str('目录权限，如 0750')),
    fileMode: opt(str('文件权限，如 0640')),
    switchStrategy: withDefault(oneOf(SWITCH_STRATEGIES, 'current 的切换方式'), 'auto'),
  },
  '发布布局',
)

/**
 * 两阶段激活。默认 trial→promote：先起新版本、验过再切流量。
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

// 项目与配置根

/**
 * 健康检查。**它的有无**决定 autoPromote 能否生效：没有 healthcheck 时`when-healthcheck-passes` 退化为 never，而不是「没人检查就当通过」。
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
     * 激活后必须存在的相对路径。static 目标的主要校验手段 ——它不需要起任何进程，也不用碰 shell，是最省资源的一种健康检查。
     */
    fileExists: opt(arr(str('release 目录中必须存在的相对路径'))),
    timeoutMs: withDefault(num('单次超时'), 5000),
    intervalMs: withDefault(num('轮询间隔'), 2000),
  },
  '健康检查。它的有无决定 autoPromote 能否生效',
)

/**
 * 一个可部署的项目。source 必填而 target 缺省：目标可以完全由探测得出（零配置路径的前提），源不行 ——「部署什么」是用户的事，「部署到哪、怎么部署」大多可以问机器。
 */
export const projectSchema = obj(
  {
    source: sourceSchema,
    hosts: opt(arr(str('引用的主机名'))),
    release: opt(releaseSchema),
    target: opt(targetSchema),
    healthcheck: opt(healthcheckSchema),
    activation: opt(activationSchema),
    transport: opt(transportSchema),
  },
  '一个可部署的项目',
)

/**
 * 配置根。`defaults` 与 `profiles` 是同一组段的两种复用方式，优先级由 `@dp/core` 合成阶段定，schema 层不判先后 ——合并语义只有一处，判两次的结果是两边对同一份配置给出不同答案。
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

// define* —— 每段一个，便于分段复用与类型提示

/** 归一化后的配置。默认值已填齐 —— 下游不必再判「用户写没写」 */
export type Config = Infer<typeof configSchema>
/**
 * 用户可写的配置形态。可省字段在这里仍是可选的，偏好链可以写单值。
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
/** 校验后的形状，可选字段已补默认值 */
export type DockerConfig = Infer<typeof dockerSchema>
/** 配置文件里的写法，字段全部可选 */
export type DockerInput = InputOf<typeof dockerSchema>
/** 归一化后的 systemd 段。restart / scope / wantedBy 一定有值 */
export type SystemdConfig = Infer<typeof systemdSchema>
/** systemd 段的可写形态，除 unitDir 外字段全部可选 */
export type SystemdInput = InputOf<typeof systemdSchema>
/** 归一化后的 process 段。stopSignal / stopTimeoutMs 一定有值 */
export type ProcessConfig = Infer<typeof processSchema>
/** process 段的可写形态，除 command 外字段全部可选 */
export type ProcessInput = InputOf<typeof processSchema>
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
 * @param c 用户写的配置，字段可省、偏好链可写单值
 * @returns 归一化后的配置：默认值已填、偏好链已是数组
 * @throws DpError 带配置路径的校验错误，如 `projects.web.source.root`
 */
export const defineConfig = (c: ConfigInput): Config => configSchema.parse(c, 'config')
/**
 * 归一化一段主机定义。
 *
 * @param c 主机段原文，ssh / hops / local 三选一
 * @returns 归一化后的主机：hops 非空或不存在，二者必居其一
 * @throws DpError ssh 与 hops 同时给出，或端口不在 1–65535
 */
export const defineHost = (c: HostInput): HostConfig => hostSchema.parse(c, 'host')
/**
 * 归一化一个项目段。与 defineConfig 走的是同一份 schema，只是错误路径前缀不同（`project.*` vs `projects.<name>.*`）。
 *
 * @param c 项目段原文
 * @returns 归一化后的项目段
 * @throws DpError 带 `project.` 前缀路径的校验错误
 */
export const defineProject = (c: ProjectInput): ProjectConfig => projectSchema.parse(c, 'project')
/**
 * 归一化源路径段。
 *
 * @param c 源段原文
 * @returns 归一化后的源段
 * @throws DpError root 以分隔符结尾，或以 `../` 开头（会逃出项目目录）
 */
export const defineSource = (c: InputOf<typeof sourceSchema>): SourceConfig =>
  sourceSchema.parse(c, 'source')
/**
 * 归一化发布布局段。keep 的缺省在这一层就填上，下游读到的必是有效数字而不是「可能没有」。
 *
 * @param c 发布段原文
 * @returns 归一化后的发布段，keep 一定有值
 * @throws DpError keep 非正整数
 */
export const defineRelease = (c: InputOf<typeof releaseSchema>): ReleaseConfig =>
  releaseSchema.parse(c, 'release')
/**
 * 归一化目标段。type 的单值 / 数组写法在这里统一成数组，pick 缺省时填 `DEFAULT_TARGET_PICK`。
 *
 * @param c 目标段原文
 * @returns 归一化后的目标段，type 为偏好链数组
 * @throws DpError type 不在 `TARGET_KINDS` 内，或某个段与 type 不一致
 */
export const defineTarget = (c: InputOf<typeof targetSchema>): TargetConfig =>
  targetSchema.parse(c, 'target')
/**
 * 归一化 nginx 段。server 的「单对象 / 对象数组」两种写法在这里分派，下游拿到的永远是数组 —— 分派逻辑只写一份。
 *
 * @param c nginx 段原文
 * @returns 归一化后的 nginx 段
 * @throws DpError reload 的 argv 里有空串元素
 */
export const defineNginx = (c: NginxInput): NginxConfig => nginxSchema.parse(c, 'nginx')
/**
 * 校验并补全 docker 段，产出不可变的配置对象
 *
 * @param c docker 段原文
 * @returns 归一化后的 docker 段
 * @throws DpError compose.files 的元素里有空串（空路径在目标机上报的错指向那个空路径）
 */
export const defineDocker = (c: DockerInput): DockerConfig => dockerSchema.parse(c, 'docker')
/**
 * 归一化 systemd 段。unit 省略时用 `<项目名>.service` 补齐，剩下的默认值在这一层填
 *
 * @param c systemd 段原文
 * @returns 归一化后的 systemd 段
 * @throws DpError unit 不是单个文件名，或 ExecStart 为空
 */
export const defineSystemd = (c: SystemdInput): SystemdConfig => systemdSchema.parse(c, 'systemd')
/**
 * 归一化 process 段。停止信号与优雅期在这一层补全
 *
 * @param c process 段原文
 * @returns 归一化后的 process 段
 * @throws DpError command 为空，或参数里有空串元素
 */
export const defineProcess = (c: ProcessInput): ProcessConfig => processSchema.parse(c, 'process')
/**
 * 归一化传输段。strategy 缺省或写 `auto` 时展开成 `DEFAULT_TRANSPORT_CHAIN`，链全失败由 core 报 `DP.PREF.UNSUPPORTED`。
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
 * 归一化健康检查段。timeoutMs / intervalMs 的缺省在这一层填上，轮询的「等多久、查一次」不被两处各写一份。
 *
 * @param c 健康检查段原文
 * @returns 归一化后的健康检查段
 * @throws DpError http 段缺 path，或 tcp 段缺 port
 */
export const defineHealthcheck = (c: InputOf<typeof healthcheckSchema>): HealthcheckConfig =>
  healthcheckSchema.parse(c, 'healthcheck')
/**
 * 归一化提权段。缺省是 `type: 'none'` 而不是「没配提权」——不提权是一等合法配置（容器里的普通用户），把它表示成 undefined会让每个消费点都要写一次「没配 = 不提权」的分支，而漏一处就等于对着普通用户去跑 sudo。
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
 * @returns 配置根对应的 JSON Schema 节点树；required 由各段的 isOptional 反推
 */
export const configJsonSchema = (): ReturnType<typeof configSchema.toJsonSchema> =>
  configSchema.toJsonSchema()
