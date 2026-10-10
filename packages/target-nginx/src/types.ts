import type { RenderContext } from '@dp/template'

/** 反代超时。单位秒，与 nginx 指令的 `Ns` 后缀一一对应 */
export interface ProxyTimeouts {
  readonly connect?: number
  readonly send?: number
  readonly read?: number
}

/**
 * 一条反代。
 */
export interface ReverseProxy {
  /**
   * 后端地址，如 `http://127.0.0.1:8080`。
   */
  readonly upstream: string
  /** 需要目标机主配置里有 `map $http_upgrade $connection_upgrade`，否则该 location 全部 502 */
  readonly websocket?: boolean
  /**
   * 缺省 = 不写 `proxy_read_timeout` 等指令，交给 nginx 自己的默认值。
   */
  readonly timeouts?: ProxyTimeouts
}

/**
 * 前缀匹配与反代目标；timeouts 全缺省时整段不渲染
 */
export interface Location {
  /** 形如 `/`、`/api/`、`= /healthz`、`~ \.php$`。必须带 nginx 认可的匹配前缀 */
  readonly path: string
  /** 相对 server 的 root 覆盖，路径类按 `path` 档校验 */
  readonly root?: string
  /** 如 `$uri $uri/ /index.html`。文本进 conf，按 `conf` 档校验 */
  readonly tryFiles?: string
  /**
   * 给了它就**不再看** `root` / `tryFiles` —— nginx 里一个 location 命中反代后不会再走静态处理。配置里同时写出来等于让读配置的人猜哪条赢，而生成的 conf不会对此给出任何提示。
   */
  readonly proxy?: ReverseProxy
  /** 逃生舱：原样输出，不渲染、不做字符替换 */
  readonly extra?: readonly string[]
}

/**
 * server 块：监听、server_name 与若干 location
 */
export interface ServerBlock {
  /** 省略（undefined）= 不按域名分流，渲染成 `server_name _;`；显式写 `[]` 是「我声明了但没填」，按歧义拒绝 */
  readonly serverName?: readonly string[]
  /** 默认 `[80]`。字符串形式带修饰符，如 `'443 ssl'` */
  readonly listen?: readonly (number | string)[]
  /** 静态根，通常是 `${release.current}`（软链）而不是某个具体 release 目录 */
  readonly root?: string
  /**
   * 缺省 `['index.html']`。显式写 `[]` 是「不要索引文件」，与缺省不同：目录请求直接 403，比悄悄回退到 index.html 更接近写配置的人的本意。
   */
  readonly index?: readonly string[]
  /**
   * 缺省为空 = 只出静态 server，不生成任何 location。nginx 主配置里默认 server 的那条 `location /` **不会被继承**，所以缺省必须是「什么都不生成」而不是「沿用默认」。
   */
  readonly locations?: readonly Location[]
  /** server 级反代；与 locations 共存（放最后，便于人读出「这个 server 整体是反代」） */
  readonly reverseProxy?: ReverseProxy
  /** 逃生舱，同 location 那一档：给了它就等于放弃对这一段的全部校验 */
  readonly extra?: readonly string[]
}

/**
 * 渲染与落盘所需的全部输入，含 confd 与 reload 命令
 */
export interface NginxTargetConfig {
  /** 单个块或多个块。多块共用一个 conf 文件，冲突由渲染期检出 */
  readonly server: ServerBlock | readonly ServerBlock[]
  /**
   * 写进 confd 的文件名，**不含目录**。默认 `${project}.conf`。
   */
  readonly filename?: string
  /**
   * 目标机上的 confd 目录。**由上层从 layout 推导后注入**（目标机路径不是配置项）。本包不读环境也不探测，只能要求调用方给。
   */
  readonly confd: string
  /**
   * 影子目录。默认 `<confd>/.dp-shadow` —— 落在 confd 之下是因为那里的可写性已经被「必须能写 `<confd>/<filename>`」这件事证过了，不必再猜一个可写位置。
   */
  readonly shadowDir?: string
  /**
   * 渲染上下文（`${env.NAME}`、`${release.current}` 等的值）。**注入而非读环境**：本包零 IO，自己去读 process.env 会让 plan() 不再是纯函数，也就无法在没有任何机器的机器上断言产出。
   */
  readonly render: RenderContext
  /** 覆盖未带 `# managed by dp` 标记的同名文件。仍然先备份 */
  readonly force?: boolean
  /** reload 命令。默认 `['nginx','-s','reload']`；`false` 表示这台机器由外部管 reload */
  readonly reload?: readonly string[] | false
}
