/**
 * conf 渲染 —— 结构化配置 → nginx conf 文本。
 *
 * 三条贯穿全程的判断：
 *
 * 1. **变量一律走 `@dp/template`。** 自己写一套 `${}` 解析会让错误码分叉成两套，
 *    而且丢掉「空值同缺值处理」这类已经想清楚的结论。
 * 2. **断言只管「安全」与「结构」两层。** `assertSafe` 是字符级闸门（挡换行、
 *    控制字符），它**不挡 `;` 与 `{`** —— 而这两个恰好是 conf 的语法边界，
 *    能被拼进去就等于往 conf 里注入了一条指令。结构判定必须自己来，两层不能互相顶替。
 * 3. **纯函数。** 不读环境、不起子进程、不碰文件系统，两次渲染逐字相同。
 */
import { DpError } from '@dp/ports'
import { assertSafe, renderString, type RenderContext, type Usage } from '@dp/template'
import { MANAGED_MARKER } from './ownership.js'
import type { Location, ReverseProxy, ServerBlock } from './types.js'

const INDENT = '  '
const DEFAULT_LISTEN: readonly (number | string)[] = [80]
const DEFAULT_INDEX: readonly string[] = ['index.html']
/** 不按域名分流时的占位域名。nginx 认它，且它是唯一不与 `server_name` 冲突的选择 */
const CATCH_ALL = '_'

/** 展开失败时补上配置项路径：模板层的错误不知道自己在渲染 nginx 的哪个字段 */
function withPath(source: DpError, path: string | undefined): DpError {
  if (path === undefined) return source
  return new DpError(source.code, source.message, {
    path,
    ...(source.hint !== undefined ? { hint: source.hint } : {}),
  })
}

/** `path` 只在调用方给了基准路径时才有值，故用 undefined 表示「不带 path」 */
function child(base: string | undefined, suffix: string): string | undefined {
  return base === undefined ? undefined : `${base}.${suffix}`
}

function confInvalid(message: string, path: string | undefined, hint: string): DpError {
  return new DpError('DP.NGX.CONF_INVALID', message, {
    ...(path !== undefined ? { path } : {}),
    hint,
  })
}

/** 模板层抛的是 DP.TPL.UNSAFE_VALUE；渲染值不合法归到 DP.NGX.UNSAFE_VALUE，两码的处置方式不同 */
function unsafe(source: DpError, path: string | undefined): DpError {
  return new DpError('DP.NGX.UNSAFE_VALUE', source.message, {
    ...(path !== undefined ? { path } : {}),
    hint:
      source.hint ??
      '这个值会直接进 conf。带换行会把一条指令拆成两条 —— 改值本身，或改用一个不落到这个位置的写法',
  })
}

interface RenderOptions {
  /** 基准配置路径，如 `projects.web.target.nginx`；错误里会拼上字段名 */
  readonly path?: string
}

/**
 * 渲染单个值。
 *
 * `usage` 按**这个值最终落在 conf 的哪个位置**选，不按「它像什么」选：
 * 路径类（root）拼进的是文件系统路径，进 `path` 档；其余（server_name / upstream /
 * location 路径 / try_files）只是 conf 文本，进 `conf` 档。
 * location 路径虽然带 `/`，但它不是文件系统路径 —— 拿 `path` 档去卡它会把
 * 合法写法（`~ \.php$` 里的 `$`、前缀里的 `= `）误杀成事故。
 */
function value(
  raw: string,
  ctx: RenderContext,
  usage: Usage,
  path: string | undefined,
): string {
  let rendered: string
  try {
    rendered = renderString(raw, ctx, { usage, ...(path !== undefined ? { path } : {}) })
  } catch (err) {
    if (err instanceof DpError) {
      if (err.code === 'DP.TPL.UNSAFE_VALUE') throw unsafe(err, path)
      throw withPath(err, path)
    }
    throw err
  }

  // 模板层只校验**被变量替换进去的那个值**，配置里直接敲进去的换行它是看不见的
  // （没有 `${}` 就没有值需要校验）。而「一个换行」正是把一条指令拆成两条的最短路径，
  // 所以这里对最终值再过一次闸 —— 这是本层与模板层职责的分界，不是重复校验。
  try {
    assertSafe(rendered, usage, path)
  } catch (err) {
    if (err instanceof DpError && err.code === 'DP.TPL.UNSAFE_VALUE') throw unsafe(err, path)
    throw err
  }
  return rendered
}

/** conf 语法边界：出现在值里就意味着「这个值多出半条指令」 */
const CONF_BOUNDARY = /[;{}]/

function assertNoConfBoundary(rendered: string, what: string, path: string | undefined): void {
  if (!CONF_BOUNDARY.test(rendered)) return
  throw confInvalid(
    `${what} 含 conf 语法边界字符（; { }）：${rendered}`,
    path,
    '这些字符是 nginx 指令的分界符，留在这里等于往 conf 里注入指令。改这个值，或把它挪到 extra（逃生舱原样输出）里自己保证结构',
  )
}

/** 指令行里的空白分隔符必须由代码决定，而不是由值带进来 */
function assertNoWhitespace(rendered: string, what: string, path: string | undefined): void {
  if (!/\s/.test(rendered)) return
  throw confInvalid(
    `${what} 含空白字符：${rendered}`,
    path,
    '值里的空白会被 nginx 当成参数分隔符，于是「一个值」变成「几个参数」。多个值请拆成配置里的多个数组项',
  )
}

/**
 * 允许**单个**空格分隔的参数，但不允许多余空白。
 *
 * `listen 443 ssl` 这类写法本身就是「地址 + 修饰符」，空格是它的一部分，直接禁掉会误伤；
 * 而连续的空格、首尾空格、换行、制表符会让同一个 token 变成两个空参数。
 */
function assertSingleSpaced(rendered: string, what: string, path: string | undefined): void {
  if (/^\S+(?: \S+)*$/.test(rendered)) return
  throw confInvalid(
    `${what} 的空白不合法：${rendered}`,
    path,
    '一个指令的值只能是「参数 空格 参数」，不能有首尾空格、连续空格或换行。它们会让 nginx 收到额外的空参数，报错时指向的地方还和真正的原因对不上',
  )
}

const UPSTREAM_RE = /^(?:https?):\/\/[^/\s:]+(?::\d{1,5})?(?:\/[^\s]*)?$/

function renderUpstream(proxy: ReverseProxy, ctx: RenderContext, base: string | undefined): string {
  const path = child(base, 'upstream')
  const upstream = value(proxy.upstream, ctx, 'conf', path)

  // 末尾斜杠：写与不写是两种完全不同的转发语义，替用户选一个必然有一半场景是错的
  if (upstream.endsWith('/')) {
    throw confInvalid(
      `upstream 末尾带斜杠：${upstream}`,
      path,
      '两种写法语义不同，不能替你决定：`http://host:8080` 会把完整的原始请求 URI 交给后端；`http://host:8080/` 会先剥掉 location 前缀再把剩下的部分交给后端。要哪种就写哪种，把斜杠去掉（不截断），或把后端路径写进 location（如 location /api/ + upstream http://host:8080/）来显式表达截断',
    )
  }

  if (!/^https?:\/\//.test(upstream)) {
    throw confInvalid(
      `upstream 不是 http(s) 地址：${upstream}`,
      path,
      '写错 scheme（例如写成 `host:8080`）时 nginx 会把 proxy_pass 当成非法值，整份 conf 在 `nginx -t` 就报错；写成 `htp://` 这类时更糟 —— 请求会被当成静态文件去找，线上表现为「nginx 起来了但接口全 404」。必须以 `http://` 或 `https://` 开头',
    )
  }

  if (!UPSTREAM_RE.test(upstream)) {
    throw confInvalid(
      `upstream 不是合法的 http(s) 地址：${upstream}`,
      path,
      '形状应为 `http://host[:port][/path]`，主机名与端口之间只允许一个冒号，path 里不允许空白。写错端口分隔符会让整份 conf 在 `nginx -t` 失败',
    )
  }

  assertNoConfBoundary(upstream, 'upstream', path)
  return upstream
}

function renderTimeouts(proxy: ReverseProxy, out: (line: string) => void): void {
  const t = proxy.timeouts
  if (t === undefined) return
  if (t.connect !== undefined) out(`proxy_connect_timeout ${renderSeconds(t.connect, 'connect')}`)
  if (t.send !== undefined) out(`proxy_send_timeout ${renderSeconds(t.send, 'send')}`)
  if (t.read !== undefined) out(`proxy_read_timeout ${renderSeconds(t.read, 'read')}`)
}

function renderSeconds(value_: number, field: string): string {
  if (!Number.isInteger(value_) || value_ < 0 || value_ > 86400) {
    throw new DpError('DP.NGX.CONF_INVALID', `timeouts.${field} 不是可用的秒数：${value_}`, {
      hint: '取 0 ~ 86400 的整数。0 会让 nginx 立刻返回 504，等于把后端判死；超过一天基本等同于没配',
    })
  }
  return `${value_}s`
}

/**
 * 反代指令。
 *
 * 默认头是 DESIGN §8.2 要求的「默认正确而不是记得才写」：少写 `X-Forwarded-For`
 * 的后果是后端拿不到真实来源 IP，而这件事在日志里看不出来。
 */
function proxyDirectives(proxy: ReverseProxy, ctx: RenderContext, base: string | undefined, out: (line: string) => void): void {
  const upstream = renderUpstream(proxy, ctx, base)
  out(`proxy_pass ${upstream}`)

  // 非 websocket 场景保持 nginx 默认：用户可能正在依赖它与后端的既有协商结果
  if (proxy.websocket === true) {
    out('proxy_http_version 1.1')
    out('proxy_set_header Upgrade $http_upgrade')
    out('proxy_set_header Connection $connection_upgrade')
  }

  out('proxy_set_header Host $host')
  out('proxy_set_header X-Real-IP $remote_addr')
  out('proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for')
  out('proxy_set_header X-Forwarded-Proto $scheme')

  renderTimeouts(proxy, out)
}

function renderLocation(loc: Location, ctx: RenderContext, base: string | undefined, out: (line: string) => void): void {
  const path = child(base, 'path')
  const renderedPath = value(loc.path, ctx, 'conf', path)
  assertNoConfBoundary(renderedPath, 'location.path', path)

  // 修饰符与路径之间**必须**留一个空格（`= /healthz` 是 nginx 的正规写法），
  // 所以空白检查落在剥掉修饰符之后：只禁路径部分里的空白，否则上面那种合法写法被误杀。
  const modifier = /^(?:\/|=|\^~|~\*|~)/.exec(renderedPath)
  const bare = renderedPath.slice(modifier?.[0].length ?? 0).trimStart()
  if (/\s/.test(bare)) {
    throw confInvalid(
      `location.path 含空白字符：${renderedPath}`,
      path,
      '值里的空白会被 nginx 当成参数分隔符，于是「一个路径」变成「几个参数」。修饰符（= / ~ ^~）后可以有一个空格，路径本身里不行',
    )
  }

  // 没有匹配前缀的 location 会被 nginx 当成普通前缀，参数直接落进路径匹配 ——
  // 这类 typo 不会报错，只会让某个路径永远匹配不上，所以在这里就拒。
  // `/` 后面本来就是空的，所以「路径部分为空」只对修饰符形式（`=` / `~`）才算错。
  if (modifier === null || (bare === '' && modifier[0] !== '/')) {
    throw confInvalid(
      `location.path 缺少合法的匹配前缀：${renderedPath}`,
      path,
      '必须以 `/`（普通前缀）、`=`（精确匹配）、`~`（正则）、`~*`（不区分大小写正则）或 `^~`（前缀且优先于正则）开头。漏掉前缀不会让 nginx 报错，只会让这个 location 匹配不到任何请求',
    )
  }

  const body: string[] = []
  // 生成的指令由这里补 `;`：终止符必须是代码给的，写在配置里就等于每个用户都要写一遍
  const emit = (line: string): void => {
    body.push(`${line};`)
  }

  if (loc.root !== undefined) {
    const rootPath = child(base, 'root')
    const rendered = value(loc.root, ctx, 'path', rootPath)
    assertNoConfBoundary(rendered, 'root', rootPath)
    emit(`root ${rendered}`)
  }
  if (loc.tryFiles !== undefined) {
    const rendered = value(loc.tryFiles, ctx, 'conf', child(base, 'tryFiles'))
    assertNoConfBoundary(rendered, 'tryFiles', child(base, 'tryFiles'))
    emit(`try_files ${rendered}`)
  }
  if (loc.proxy !== undefined) {
    proxyDirectives(loc.proxy, ctx, child(base, 'proxy'), emit)
  }

  // 逃生舱原样输出：连 `;` 都不动
  for (const line of loc.extra ?? []) body.push(line)

  if (body.length === 0) {
    throw confInvalid(
      `location ${renderedPath} 里没有任何指令`,
      base,
      '空的 location 块不会报错，它只是什么都不匹配 —— 线上表现为这个路径一律 404，且很难联想到是 conf 少了一行。要拒绝访问请写 `extra: ["deny all;"]`；要转后端请写 proxy；要出静态页请写 root / tryFiles',
    )
  }

  out(`location ${renderedPath} {`)
  for (const line of body) out(`${INDENT}${line}`)
  out('}')
}

function renderListen(listen: readonly (number | string)[], ctx: RenderContext, base: string | undefined, out: (line: string) => void): void {
  const path = child(base, 'listen')
  for (const item of listen) {
    if (typeof item === 'number') {
      if (!Number.isInteger(item) || item < 1 || item > 65535) {
        throw confInvalid(`listen 端口越界：${item}`, path, '取 1 ~ 65535 的整数')
      }
      out(`listen ${item}`)
      continue
    }
    const rendered = value(item, ctx, 'conf', path)
    assertNoConfBoundary(rendered, 'listen', path)
    assertSingleSpaced(rendered, 'listen', path)
    if (rendered === '') throw confInvalid('listen 是空串', path, '删掉这一项，或写上端口；空串会让 nginx 在 `nginx -t` 报 "invalid number of arguments"')
    out(`listen ${rendered}`)
  }
}

function renderServerNames(
  serverName: readonly string[] | undefined,
  ctx: RenderContext,
  base: string | undefined,
  out: (line: string) => void,
): readonly string[] {
  const path = child(base, 'serverName')

  // 省略与 `[]` 是两件事：省略 = 不按域名分流（`_` 正是这个意思）；
  // 显式 `[]` = 「我声明了但没填」，替它选一个默认值就是在替用户做决策 ——
  // 静默变成 `_` 会让这个 server 变成 catch-all，可能盖掉同一端口上的其他 vhost。
  if (serverName === undefined) {
    out(`server_name ${CATCH_ALL}`)
    return [CATCH_ALL]
  }

  if (serverName.length === 0) {
    throw confInvalid(
      'serverName 是空数组',
      path,
      '要按域名分流就填域名；要不按域名分流就**删掉这个字段**（渲染成 `server_name _`）。显式写空数组会被静默当成 `_`，那个 server 会成为 catch-all 并可能盖掉同端口的其他 vhost',
    )
  }

  const names: string[] = []
  for (const name of serverName) {
    const rendered = value(name, ctx, 'conf', path)
    assertNoConfBoundary(rendered, 'serverName', path)
    assertNoWhitespace(rendered, 'serverName', path)
    if (rendered === '') throw confInvalid('serverName 含空串', path, '删掉空串，或删掉整个 serverName 字段')
    names.push(rendered)
  }
  out(`server_name ${names.join(' ')}`)
  return names
}

function renderServer(block: ServerBlock, ctx: RenderContext, base: string | undefined, out: (line: string) => void): readonly string[] {
  const body: string[] = []
  const emit = (line: string): void => {
    body.push(`${line};`)
  }
  // 块的开合行与 extra 原样进 body —— 它们不是本层生成的指令，末尾不该有 `;`
  const push = (line: string): void => {
    body.push(line)
  }

  renderListen(block.listen ?? DEFAULT_LISTEN, ctx, child(base, 'listen'), emit)
  const names = renderServerNames(block.serverName, ctx, base, emit)

  if (block.root !== undefined) {
    const rootPath = child(base, 'root')
    const rendered = value(block.root, ctx, 'path', rootPath)
    // `path` 档只挡控制字符与跨平台的非法字符，`;` / `{}` 不在其中 ——
    // 而 root 是被拼进 `root <值>;` 的，值里带一个分号就多出一条指令。
    assertNoConfBoundary(rendered, 'root', rootPath)
    emit(`root ${rendered}`)
  }
  const index = block.index ?? DEFAULT_INDEX
  if (index.length === 0) {
    throw confInvalid('index 是空数组', child(base, 'index'), '删掉这个字段会退回 `index index.html`；显式空数组会让 `index` 指令没有参数，nginx 在 `nginx -t` 就失败')
  }
  const indexNames = index.map((item) => {
    const indexBase = child(base, 'index')
    const rendered = value(item, ctx, 'conf', indexBase)
    assertNoWhitespace(rendered, 'index', indexBase)
    // 空白检查挡不住 `a.html;root` —— 分号后面没有空格也会被 nginx 切成两条指令
    assertNoConfBoundary(rendered, 'index', indexBase)
    if (rendered === '') throw confInvalid('index 含空串', indexBase, '删掉空串')
    return rendered
  })
  emit(`index ${indexNames.join(' ')}`)

  for (const [i, loc] of (block.locations ?? []).entries()) {
    renderLocation(loc, ctx, child(child(base, 'locations'), `[${i}]`), push)
  }

  if (block.reverseProxy !== undefined) {
    proxyDirectives(block.reverseProxy, ctx, child(base, 'reverseProxy'), emit)
  }

  // 逃生舱原样输出：连 `;` 都不补
  for (const line of block.extra ?? []) push(line)

  // 「有内容来源」按来源数而不是按行数判定：listen 有几条与这个判断无关，
  // 靠 `body.length` 去反推一旦将来多渲染一行固定指令就会静默失效。
  const hasContent = block.root !== undefined || (block.locations?.length ?? 0) > 0 || block.reverseProxy !== undefined || (block.extra?.length ?? 0) > 0
  if (!hasContent) {
    // 只有默认的 listen / server_name / index，没有任何内容来源。
    // 它不会让 `nginx -t` 失败，却会按 nginx 的默认 root 找文件 —— 线上表现是
    // "服务起来了但返回一堆 404"，几乎不可能被联想到是 conf 里少了一行 root。
    throw confInvalid(
      'server 块里没有任何内容来源（无 root / locations / reverseProxy）',
      base,
      '补上 `root`（配 release.current 软链）、`locations`，或在 `extra` 里显式写自己的指令（例如只做跳转的 server：`extra: ["return 301 https://$host$request_uri;"]` —— extra 是原样输出的，nginx 变量直接写，不要转义）',
    )
  }

  out('server {')
  for (const line of body) out(`${INDENT}${line}`)
  out('}')
  return names
}

/** 同一个文件里两个 server 抢同一个域名，nginx -t 报 conflicting server name —— 在这里先报 */
function assertNoConflictingNames(entries: readonly { readonly base?: string; readonly names: readonly string[] }[]): void {
  const seen = new Map<string, string | undefined>()
  for (const entry of entries) {
    for (const name of entry.names) {
      // 用 has 而不是 `get(...) !== undefined`：base 本身就是 undefined 时
      // 「首次出现」与「没有出现过」分不开，冲突就永远检不出来
      if (seen.has(name)) {
        const owner = seen.get(name)
        throw confInvalid(
          `server_name ${name} 在同一份 conf 里出现多次`,
          child(entry.base, 'serverName'),
          `首次定义在 ${owner ?? '(第一个 server)'}。nginx 会在 \`nginx -t\` 报 conflicting server name，两个 server 抢同一个域名时它的行为是「先声明的赢」，不会给你任何提示`,
        )
      }
      seen.set(name, entry.base)
    }
  }
}

function assertNoDuplicateLocations(block: ServerBlock, ctx: RenderContext, base: string | undefined): void {
  const seen = new Set<string>()
  for (const [i, loc] of (block.locations ?? []).entries()) {
    const rendered = value(loc.path, ctx, 'conf', child(child(base, 'locations'), `[${i}].path`))
    if (seen.has(rendered)) {
      throw confInvalid(
        `location ${rendered} 重复定义`,
        child(base, 'locations'),
        '同一个 server 里同名 location 会被 nginx -t 判为 duplicate location，shadow 校验会在这里就失败，不会走到远端',
      )
    }
    seen.add(rendered)
  }
}

/**
 * 渲染成一份完整 conf。**结尾带换行**，两次同输入逐字相同。
 *
 * 标记放在文件头而不是每个 server 块里：所有权保护判的是「这个文件是不是 dp 的」，
 * 一份文件里放几个 server 不影响这个判断。
 */
export function renderConf(
  server: ServerBlock | readonly ServerBlock[],
  ctx: RenderContext,
  options?: RenderOptions,
): string {
  const blocks = Array.isArray(server) ? server : [server]
  if (blocks.length === 0) {
    throw confInvalid('server 为空数组', options?.path, '至少给一个 server 块；空数组渲染出的是一份不含任何 server 的 conf，nginx 起来后按默认站点应答，线上表现为域名不对而不是报错')
  }

  const out: string[] = []
  const entries: { base: string | undefined; names: readonly string[] }[] = []
  for (const [i, block] of blocks.entries()) {
    const base = Array.isArray(server) ? child(options?.path, `server[${i}]`) : child(options?.path, 'server')
    assertNoDuplicateLocations(block, ctx, base)
    const sub: string[] = []
    const names = renderServer(block, ctx, base, (line) => sub.push(line))
    out.push(...sub)
    entries.push({ base, names })
  }
  assertNoConflictingNames(entries)

  const header = [
    MANAGED_MARKER,
    `# 由 dp 生成，直接改这个文件会在下次部署时被覆盖；配置请改 ${options?.path ?? 'projects.*.target.nginx'}`,
  ]
  return `${[...header, ...out].join('\n')}\n`
}

/**
 * 影子主配置 —— `nginx -t -c <它>` 的输入。
 *
 * `includes` 必须是**排除掉待替换文件之后**的真实 confd 清单：候选文件与旧文件
 * 同时被 include 会得到两份抢同一端口/域名的 server，`nginx -t` 必然报冲突，
 * 于是「替换」永远过不了第一步校验。列目录是 IO，由执行器（下一轮）算出后传进来。
 */
export function renderShadowMainConf(options: {
  readonly includes: readonly string[]
  readonly candidate: string
  readonly path?: string
}): string {
  const lines = [
    MANAGED_MARKER,
    '# 影子主配置：只为在不碰生产目录的前提下让 `nginx -t` 解析候选文件。它不是生产主配置，',
    '# 目的路径、日志、mime.types 等一概不管 —— 校验范围是新文件本身与 include 能否解析。',
    'events { }',
    'http {',
  ]
  for (const include of options.includes) {
    if (include.includes(';') || include.includes('{') || include.includes('}') || /\s/.test(include)) {
      throw confInvalid(
        `include 路径含非法字符：${include}`,
        child(options.path, 'includes'),
        '这些路径会逐行进主配置，空白/分号/花括号都会破坏结构。列目录得到的名字本不该含这些，出现即说明 confd 下有畸形文件名',
      )
    }
    lines.push(`${INDENT}include ${include};`)
  }
  lines.push(`${INDENT}include ${options.candidate};`)
  lines.push('}')
  return `${lines.join('\n')}\n`
}
