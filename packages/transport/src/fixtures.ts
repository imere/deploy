import type { Facts } from '@dp/ports'

export type Tools = Readonly<Record<string, string | null>>

export function makeFacts(overrides: {
  readonly host: string
  readonly tools: Tools
  readonly platform?: Facts['platform']
}): Facts {
  return {
    host: overrides.host,
    platform: overrides.platform ?? 'linux',
    arch: 'x64',
    init: 'systemd',
    homedir: '/home/deployer',
    tmpdir: '/tmp',
    env: {},
    capabilities: {
      canWrite: { '/tmp': true },
      canChown: [],
      canSymlink: true,
      systemdScope: 'system',
      lingerEnabled: false,
      canBindPrivilegedPort: false,
      sudoAllowlist: [],
    },
    tools: overrides.tools,
  }
}

/** 本地典型组合：无 rsync，有 tar（明写的事实） */
export const LOCAL_NO_RSYNC = makeFacts({
  host: 'local',
  tools: { ssh: '/usr/bin/ssh', tar: '/usr/bin/tar', scp: '/usr/bin/scp', rsync: null, sftp: '/usr/bin/sftp' },
})

export const LOCAL_WITH_RSYNC = makeFacts({
  host: 'local',
  tools: {
    ssh: '/usr/bin/ssh',
    tar: '/usr/bin/tar',
    scp: '/usr/bin/scp',
    rsync: '/usr/bin/rsync',
    sftp: '/usr/bin/sftp',
  },
})

export const REMOTE_WITH_RSYNC = makeFacts({
  host: 'dp-target',
  tools: {
    ssh: '/usr/sbin/ssh',
    tar: '/bin/tar',
    scp: '/usr/bin/scp',
    rsync: '/usr/bin/rsync',
    sftp: null,
  },
})

export const REMOTE_TAR_ONLY = makeFacts({
  host: 'dp-target',
  tools: { ssh: '/usr/sbin/ssh', tar: '/bin/tar', rsync: null, scp: '/usr/bin/scp' },
})
