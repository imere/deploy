/**
 * nginx 目标的配置形状。
 *
 * 这里是**用户写的东西**与**上层注入的东西**的分界。`confd` / `render` /
 * `shadowDir` 都不是配置项：它们由实测能力与部署上下文推导（docs/config.md §4
 * 的「路径不是配置项」），所以在本包里是必填的依赖而不是可选项 ——
 * 缺了就得猜，猜出来的路径会让 `nginx -t` 验到另一台机器的配置上去。
 */
import type { RenderContext } from '@dp/template'

/** 反代超时。单位秒，与 nginx 指令的 `Ns` 后缀一一对应 */
export interface ProxyTimeouts {
  readonly connect?: number
  readonly send?: number
  readonly read?: number
}

export interface ReverseProxy {
  /**
   * 后端地址，如 `http://127.0.0.1:8080`。
   *
   * **末尾斜杠在这里是非法的**：nginx 对 `proxy_pass` 末尾 `/` 的语义是
   * 「用正则替换 location 前缀后交给后端」，写与不写是两种完全不同的行为。
   * 本仓不替用户决定（铁律 2），所以显式报错并在 hint 里写清两种写法各是什么。
   */
  readonly upstream: string
  /** 走 Upgrade/Connection 头。**需要目标机主配置里有 `map $http_upgrade $connection_upgrade`**，否则该 location 全部 502 */
  readonly websocket?: boolean
  readonly timeouts?: ProxyTimeouts
}

export interface Location {
  /** 形如 `/`、`/api/`、`= /healthz`、`~ \.php$`。必须带 nginx 认可的匹配前缀 */
  readonly path: string
  /** 相对 server 的 root 覆盖，路径类按 `path` 档校验 */
  readonly root?: string
  /** 如 `$uri $uri/ /index.html`。文本进 conf，按 `conf` 档校验 */
  readonly tryFiles?: string
  readonly proxy?: ReverseProxy
  /** 逃生舱：原样输出，不渲染、不做字符替换 */
  readonly extra?: readonly string[]
}

export interface ServerBlock {
  /** 省略（undefined）= 不按域名分流，渲染成 `server_name _;`；显式写 `[]` 是「我声明了但没填」，按歧义拒绝 */
  readonly serverName?: readonly string[]
  /** 默认 `[80]`。字符串形式带修饰符，如 `'443 ssl'` */
  readonly listen?: readonly (number | string)[]
  /** 静态根，通常是 `${release.current}`（软链）而不是某个具体 release 目录 */
  readonly root?: string
  readonly index?: readonly string[]
  readonly locations?: readonly Location[]
  /** server 级反代；与 locations 共存（放最后，便于人读出「这个 server 整体是反代」） */
  readonly reverseProxy?: ReverseProxy
  readonly extra?: readonly string[]
}

export interface NginxTargetConfig {
  /** 单个块或多个块。多块共用一个 conf 文件，冲突由渲染期检出 */
  readonly server: ServerBlock | readonly ServerBlock[]
  /**
   * 写进 confd 的文件名，**不含目录**。默认 `${project}.conf`。
   * 含分隔符会被拒绝 —— 它是 confd 里的一个名字，路径逃逸要在这里掐掉。
   */
  readonly filename?: string
  /**
   * 目标机上的 confd 目录。**由上层从 layout 推导后注入**（docs/config.md §4：
   * 目标机路径不是配置项）。本包不读环境也不探测，只能要求调用方给。
   */
  readonly confd: string
  /**
   * 影子目录。默认 `<confd>/.dp-shadow` —— 落在 confd 之下是因为那里的可写性
   * 已经被「必须能写 `<confd>/<filename>`」这件事证过了，不必再猜一个可写位置。
   */
  readonly shadowDir?: string
  /**
   * 渲染上下文（`${env.NAME}`、`${release.current}` 等的值）。**注入而非读环境**：
   * 本包零 IO，自己去读 process.env 会让 plan() 不再是纯函数，也就无法在
   * 没有任何机器的机器上断言产出。
   */
  readonly render: RenderContext
  /** 覆盖未带 `# managed by dp` 标记的同名文件。仍然先备份 */
  readonly force?: boolean
  /** reload 命令。默认 `['nginx','-s','reload']`；`false` 表示这台机器由外部管 reload */
  readonly reload?: readonly string[] | false
}
