// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * shellgit.mjs —— 在 shell 命令文本里找出"会动仓库状态"的 git 调用。
 *
 * 这是 `git` 工具的另一半：工具负责"让正确的路径变短"，这里负责"让绕路变贵"。
 * `ctx.tools.guard` 拿到的是 pwsh/bash 的原始 `command` 字符串，本模块把它解析成
 * "这条命令里有没有 git 写操作"，命中就由 guard 拒绝该次调用并给出替代调用方式。
 *
 * 两个方向上的取舍：
 *   * **fail-closed**：只有一份**只读子命令白名单**（status/log/diff/…），白名单之外一律算写操作。
 *     新增 git 子命令不会自动获得 shell 豁免权；`git lfs`、`git maintenance` 这类"看起来无害"的
 *     子命令也默认被拦，需要时显式加进白名单。
 *   * **宁可漏报不可误报**：只把**命令位置**（段首、`;`/`&&`/`|`/换行之后、启动器之后）的 `git`
 *     当作调用。提交信息、grep 模式、字符串字面量里出现的 "git commit" 不触发拦截——否则
 *     `Write-Output "别用 git commit"` 这种完全无害的命令会被拒。
 *
 * 已知边界（写在 README 里）：别名、`git` 的 PowerShell 函数包装、以及把命令拆进多层字符串里
 * 的写法可以绕过；guard 是**约束**，不是沙箱。真正的边界是"提交信息由工具拼装"这件事本身。
 */

/** 只读子命令：这些在 shell 里跑不改变仓库状态（不改 ref、不改索引、不改工作区）。 */
export const READ_ONLY_SUBCOMMANDS = new Set([
  'version',
  'help',
  'status',
  'log',
  'diff',
  'diff-tree',
  'diff-index',
  'diff-files',
  'show',
  'show-ref',
  'show-branch',
  'blame',
  'annotate',
  'describe',
  'shortlog',
  'grep',
  'ls-files',
  'ls-remote',
  'ls-tree',
  'cat-file',
  'rev-parse',
  'rev-list',
  'for-each-ref',
  'name-rev',
  'merge-base',
  'count-objects',
  'verify-pack',
  'verify-commit',
  'verify-tag',
  'check-ignore',
  'check-attr',
  'check-ref-format',
  'check-mailmap',
  'var',
  'whatchanged',
  'archive',
  'format-patch',
  'fast-export',
  'get-tar-commit-id',
  'stripspace',
  'column',
  'interpret-trailers',
  'patch-id',
  'unpack-file',
  'fsck',
  'gc',
  'bugreport',
  'credential',
  'diagnose',
  'hooks',
  'range-diff',
])

/** 已知会改仓库状态的子命令：拒绝理由与"未知子命令"分开，提示词才能说得更准。 */
export const STATEFUL_SUBCOMMANDS = new Set([
  'add',
  'am',
  'apply',
  'bisect',
  'branch',
  'checkout',
  'checkout-index',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'commit-tree',
  'config',
  'fetch',
  'filter-branch',
  'hash-object',
  'index-pack',
  'init',
  'mktag',
  'mktree',
  'mv',
  'notes',
  'pack-objects',
  'prune',
  'pull',
  'push',
  'read-tree',
  'rebase',
  'reflog',
  'remote',
  'repack',
  'replace',
  'rerere',
  'reset',
  'restore',
  'revert',
  'rm',
  'sparse-checkout',
  'stash',
  'submodule',
  'switch',
  'symbolic-ref',
  'tag',
  'unpack-objects',
  'update-index',
  'update-ref',
  'update-server-info',
  'worktree',
  'write-tree',
  'lfs',
  'maintenance',
  'filter-repo',
])

/** git 自身的、会吃掉一个值的全局选项（`git -C <path> status` / `git -c k=v status`）。 */
const GLOBAL_VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
])

/** 会把后续文本当作命令再执行一次的启动器：递归扫它们的参数。 */
const LAUNCHERS = new Set([
  'pwsh',
  'powershell',
  'pwsh.exe',
  'powershell.exe',
  'bash',
  'bash.exe',
  'sh',
  'dash',
  'zsh',
  'wsl',
  'env',
  'sudo',
  'doas',
  'nohup',
  'time',
  'cmd',
  'cmd.exe',
  'cscript',
])

/** 参数形状不定的启动器：退回正则扫整段文本。 */
const WRAPPERS = new Set(['start-process', 'start', 'iex', 'invoke-expression', 'call', '&'])

const MAX_DEPTH = 3

function basename(token) {
  const normalized = token.replace(/^["']|["']$/g, '')
  const parts = normalized.split(/[\\/]/)
  return (parts[parts.length - 1] ?? '').toLowerCase()
}

/** 按 PowerShell/bash 的分隔符切段，两侧引号内的分隔符不算。 */
export function splitSegments(text) {
  const out = []
  let buffer = ''
  let quote = null
  const source = String(text)
  for (let index = 0; index < source.length; index++) {
    const char = source[index]
    if (quote !== null) {
      buffer += char
      if (char === quote) quote = null
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      buffer += char
      continue
    }
    if (char === '\n' || char === ';' || char === '|' || char === '&') {
      out.push(buffer)
      buffer = ''
      if ((char === '&' || char === '|') && source[index + 1] === char) index++
      continue
    }
    buffer += char
  }
  out.push(buffer)
  return out
}

/** 去引号的粗分词：引号内的空白保留在同一个 token 里。 */
export function tokenize(text) {
  const out = []
  let buffer = ''
  let quote = null
  for (const char of String(text)) {
    if (quote !== null) {
      if (char === quote) quote = null
      else buffer += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (buffer !== '') {
        out.push(buffer)
        buffer = ''
      }
      continue
    }
    buffer += char
  }
  if (buffer !== '') out.push(buffer)
  return out
}

/** 双分支子命令的判定表：返回 'read' 或 'write'。 */
const DUAL_HANDLERS = {
  config(args) {
    const readFlags = ['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--list', '-l', '--show-origin', '--show-scope', '--name-only']
    if (args.some((arg) => readFlags.includes(arg))) return 'read'
    if (args.length === 0 || args.every((arg) => arg.startsWith('-'))) return 'read'
    return args.filter((arg) => !arg.startsWith('-')).length >= 2 ? 'write' : 'read'
  },
  branch(args) {
    const writeFlags = ['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy', '--edit-description', '--set-upstream-to', '-u', '--unset-upstream', '--create-reflog']
    if (args.some((arg) => writeFlags.includes(arg) || arg.startsWith('--set-upstream-to='))) return 'write'
    return args.some((arg) => !arg.startsWith('-')) ? 'write' : 'read'
  },
  remote(args) {
    if (args.length === 0) return 'read'
    const first = args[0]
    if (['show', 'get-url'].includes(first)) return 'read'
    if (args.every((arg) => arg.startsWith('-'))) return 'read'
    return 'write'
  },
  tag(args) {
    if (args.some((arg) => ['-l', '--list', '-n', '--contains', '--points-at', '--merged', '--no-merged', '--format'].includes(arg))) return 'read'
    if (args.some((arg) => ['-d', '--delete', '-a', '--annotate', '-s', '--sign', '-f', '--force', '-m', '--message'].includes(arg))) return 'write'
    return args.some((arg) => !arg.startsWith('-')) ? 'write' : 'read'
  },
  stash(args) {
    if (args.length === 0) return 'write'
    return ['list', 'show'].includes(args[0]) ? 'read' : 'write'
  },
  reflog(args) {
    if (args.length === 0) return 'read'
    return ['show', 'exists'].includes(args[0]) ? 'read' : 'write'
  },
  worktree(args) {
    return args.length > 0 && ['list'].includes(args[0]) ? 'read' : 'write'
  },
  submodule(args) {
    return args.length > 0 && ['status', 'summary'].includes(args[0]) ? 'read' : 'write'
  },
  notes(args) {
    return args.length > 0 && ['list', 'show'].includes(args[0]) ? 'read' : 'write'
  },
  'sparse-checkout': (args) => (args.length > 0 && args[0] === 'list' ? 'read' : 'write'),
  bisect: (args) => (args.length > 0 && ['log', 'view', 'visualize'].includes(args[0]) ? 'read' : 'write'),
  lfs: (args) => (args.length > 0 && ['env', 'version', 'ls-files', 'logs', 'status', 'track'].includes(args[0]) ? 'read' : 'write'),
  maintenance: () => 'write',
}

/**
 * 把一个 git 调用的参数（不含 `git` 本身）分类。
 * @param args - 形如 `['-C', 'repo', 'commit', '-m', 'x']`。
 * @returns `{ kind: 'read' | 'write', subcommand, reason }`；`subcommand` 为 null 表示没有子命令
 *          （`git --version` / 只有全局选项），按只读处理。
 */
export function classifyGitArgs(args) {
  const tokens = Array.isArray(args) ? args.map((item) => String(item)) : []
  let index = 0
  let subcommand = null
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') break
    if (GLOBAL_VALUE_OPTS.has(token)) {
      index += 2
      continue
    }
    if (/^-(c|C).+/.test(token)) {
      index += 1
      continue
    }
    if (token.startsWith('-')) {
      index += 1
      continue
    }
    subcommand = token
    break
  }
  if (subcommand === null) return { kind: 'read', subcommand: null, reason: 'no subcommand' }
  const rest = tokens.slice(index + 1)
  const handler = DUAL_HANDLERS[subcommand]
  if (handler !== undefined) {
    const kind = handler(rest)
    return { kind, subcommand, reason: kind === 'read' ? 'read-only form' : 'state-changing form' }
  }
  if (READ_ONLY_SUBCOMMANDS.has(subcommand)) {
    return { kind: 'read', subcommand, reason: 'read-only subcommand' }
  }
  return {
    kind: 'write',
    subcommand,
    reason: STATEFUL_SUBCOMMANDS.has(subcommand) ? 'state-changing subcommand' : 'subcommand is not on the read-only allowlist',
  }
}

/**
 * 在一条 shell 命令文本里查找 git 写操作。
 * @param command - pwsh / bash 的 `command` 原文。
 * @returns 命中时返回 `{ subcommand, reason, segment }`，否则 null。
 */
export function detectShellGitWrite(command) {
  if (typeof command !== 'string' || command.trim() === '') return null
  return scan(command, 0)
}

function scan(text, depth) {
  if (depth > MAX_DEPTH) return null
  for (const segment of splitSegments(text)) {
    const tokens = tokenize(segment).filter((token) => token !== ',' && token !== '&')
    let index = 0
    // 跳过 `FOO=bar` 形式的环境赋值前缀。
    while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++
    if (index >= tokens.length) continue
    const head = tokens[index]
    const base = basename(head)

    if (base === 'git' || base === 'git.exe') {
      const verdict = classifyGitArgs(tokens.slice(index + 1))
      if (verdict.kind === 'write') {
        return { subcommand: verdict.subcommand, reason: verdict.reason, segment: segment.trim() }
      }
      continue
    }

    if (WRAPPERS.has(base)) {
      const nested = scan(tokens.slice(index + 1).join(' '), depth + 1)
      if (nested !== null) return nested
      const match = /\bgit(?:\.exe)?\b[^A-Za-z0-9_-]*((?:-[^\s"']+\s+)*)([a-z][a-z-]*)/i.exec(segment)
      if (match !== null) {
        const verdict = classifyGitArgs(match[1].trim() === '' ? [match[2]] : [...match[1].trim().split(/\s+/), match[2]])
        if (verdict.kind === 'write') {
          return { subcommand: verdict.subcommand, reason: verdict.reason, segment: segment.trim() }
        }
      }
      continue
    }

    if (LAUNCHERS.has(base)) {
      // 启动器后的选项（`-c` / `-Command` / `/c`）不参与判定，剩下的文本当成一条新命令再扫。
      const rest = tokens.slice(index + 1).filter((token) => !/^[-/]/.test(token))
      if (rest.length === 0) continue
      const nested = scan(rest.join(' '), depth + 1)
      if (nested !== null) return nested
    }
  }
  return null
}
