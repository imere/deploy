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
 * @property {string} root     靶机上的发布根
 * @property {object} target   projects.*.target 整段
 */

/** @type {readonly Scenario[]} */
export const SCENARIOS = [
  {
    name: 'static',
    project: 'static-site',
    src: 'static',
    root: '/srv/static',
    target: { type: 'static' },
  },
  {
    name: 'nginx',
    project: 'web',
    src: 'nginx',
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
    root: '/srv/proc',
    target: {
      type: 'process',
      process: {
        command: '/usr/local/bin/node',
        args: ['${release.current}/server.js', '8082', '${release.current}/index.html'],
        workingDirectory: '${release.current}',
        pidFile: '.dp/app.pid',
        stdoutLog: '.dp/app.log',
      },
    },
  },
  {
    name: 'systemd',
    project: 'sysd',
    src: 'app',
    root: '/srv/sysd',
    target: {
      type: 'systemd',
      systemd: {
        unit: 'dp-it-app.service',
        description: 'integration fixture',
        execStart: '/usr/local/bin/node ${release.current}/server.js',
        workingDirectory: '${release.current}',
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
  return {
    hosts: { target: host },
    projects: {
      [scenario.project]: {
        hosts: ['target'],
        source: { root: `/work/src/${scenario.src}` },
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

/** 本机「只过形状」那一份：换成 local，不需要 ssh 也能跑 plan */
export const LOCAL_HOST = { local: true }

export const scenarioByName = (name) => SCENARIOS.find((s) => s.name === name)
