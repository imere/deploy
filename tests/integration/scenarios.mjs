/**
 * 四个场景的定义：**配置形状只有这一份**。
 *
 * 集成脚本用它去真机上跑，本机那个「先把配置过一遍」的检查也用它 ——
 * 各写一份的下场是检查说通过、真跑才爆未知字段，而那要等到起完容器才知道。
 */

/**
 * @typedef {object} Scenario
 * @property {string} name     场景名，也是配置文件名
 * @property {string} project  项目名（进 unit 名、conf 名，所以是有意义的）
 * @property {string} src      客户端里的源目录（/work/src/<src>）
 * @property {string} srcMode  contents = 只放目录内容；self = 连目录本身一起放过去
 * @property {string} root     靶机上的发布根
 * @property {string} [hostKind] 'hops' = 这一份的 host 段走多跳（ssh 与 hops 互斥）
 * @property {object} target   projects.*.target 整段
 */

/**
 * `srcMode` 是刻意分开的：两种写法在传输层拼出的源路径差一层目录名
 * （`self` 把 `app/server.js` 相对到 root 的父目录），真机上错一次就是
 * rsync exit 23 + 0 个文件，而报告里看不出是路径拼错。所以静态与 nginx 走
 * contents（版本目录里就是站点内容），process / systemd 走 self（版本目录里
 * 带一层源目录名）—— 两条路都必须在真机上被跑过。
 *
 * @type {readonly Scenario[]} */
export const SCENARIOS = [
  {
    name: 'static',
    project: 'static-site',
    src: 'static',
    srcMode: 'contents',
    root: '/srv/static',
    target: { type: 'static' },
  },
  {
    name: 'nginx',
    project: 'web',
    src: 'nginx',
    srcMode: 'contents',
    root: '/srv/nginx',
    target: {
      type: 'nginx',
      nginx: {
        server: {
          serverName: ['target'],
          listen: [8080],
          // 软链而不是具体版本目录：换版本时不改 conf
          root: '${release.current}',
          index: ['index.html'],
        },
      },
    },
  },
  {
    name: 'process',
    project: 'app',
    src: 'app',
    srcMode: 'self',
    root: '/srv/proc',
    target: {
      type: 'process',
      process: {
        command: '/usr/local/bin/node',
        // self 模式：版本目录里带一层源目录名，脚本在 <release>/app/ 下
        args: ['${release.current}/app/server.js', '8082', '${release.current}/app/index.html'],
        workingDirectory: '${release.current}/app',
        pidFile: '.dp/app.pid',
        stdoutLog: '.dp/app.log',
      },
    },
  },
  {
    // 与 static 同一个目标类型，差别只在**怎么连过去**：经一跳跳板。
    // 多跳的语义是「最后一跳就是目标机」，而这份配置不体现那件事 ——
    // 它体现的是「走跳板也能部署完」，落点仍是 /srv/hops 下那份静态站点
    name: 'hops',
    project: 'hop-site',
    src: 'static',
    srcMode: 'contents',
    root: '/srv/hops',
    hostKind: 'hops',
    target: { type: 'static' },
  },
  {
    name: 'systemd',
    project: 'sysd',
    src: 'app',
    srcMode: 'self',
    root: '/srv/sysd',
    target: {
      type: 'systemd',
      systemd: {
        unit: 'dp-it-app.service',
        description: 'integration fixture',
        execStart: '/usr/local/bin/node ${release.current}/app/server.js',
        workingDirectory: '${release.current}/app',
        environment: { PORT: '8083' },
        user: 'dp',
        scope: 'system',
      },
    },
  },
]

/**
 * 一份可跑的配置。
 *
 * @param {Scenario} scenario 场景定义
 * @param {object} host hosts.target 那一段（真机是 ssh 串，本机检查是 local）
 * @returns 配置文件的内容
 */
export function configFor(scenario, host) {
  // `**` 表「目录内容」，不写就是「目录本身」—— 两种写法在传输层差一层目录名
  const root = scenario.srcMode === 'contents' ? `/work/src/${scenario.src}/**` : `/work/src/${scenario.src}`
  return {
    hosts: { target: host },
    projects: {
      [scenario.project]: {
        hosts: ['target'],
        source: { root },
        release: { root: scenario.root, keep: 3 },
        target: scenario.target,
      },
    },
  }
}

/** 真机上那一份 host 段。ssh 用户是普通用户 dp，写系统目录全靠 become */
export function sshHost(targetHost) {
  return {
    ssh: `dp@${targetHost}:22`,
    become: { type: 'sudo', user: 'root', method: 'nopasswd' },
    transport: { strategy: 'auto' },
  }
}

/**
 * 多跳那一份。`hops` 与 `ssh` 互斥，**最后一跳就是目标机** ——
 * 中间那几跳只负责转发，目标机上不会再连一次自己。
 *
 * @param {string[]} jumps 跳板机（真机是 IP，形状检查时是占位串）
 * @param {string} targetHost 目标机
 * @returns hosts.* 的那一段
 */
export function hopsHost(jumps, targetHost) {
  return {
    hops: [...jumps, targetHost].map((h) => ({ ssh: `dp@${h}:22` })),
    become: { type: 'sudo', user: 'root', method: 'nopasswd' },
    transport: { strategy: 'auto' },
  }
}

/** 本机「只过形状」那一份：换成 local，不需要 ssh 也能跑 plan */
export const LOCAL_HOST = { local: true }

export const scenarioByName = (name) => SCENARIOS.find((s) => s.name === name)
