// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * shellgit.mjs —— 在 shell 命令文本里找出**会产生提交信息**的 git 调用。
 *
 * 这一层只做一件事，规则一句话说得完：
 *
 *   **拦下会写提交信息的命令（commit / merge / commit-tree），其余 git 命令照常跑。**
 *
 * 为什么只留这一条：`git_commit` 存在的意义是"提交信息由结构化字段拼装并校验"，所以只要
 * `git commit -m "<口语>"` 这条路走不通，目的就达到了。其它子命令（add/push/pull/rebase/reset/
 * clean/clone/…）既不产生模型手写的信息，也各有各的正常用法；把它们一并拦掉只会让人撞墙后
 * 另找绕路，收益是负的。
 *
 * 两个方向上的取舍：
 *   * **只认命令位置**：段首、`;`/`&&`/`|`/换行之后、启动器（pwsh/bash/env/sudo…）之后出现的
 *     `git` 才算调用。提交信息、grep 模式、字符串字面量里的 "git commit" 不触发——否则
 *     `Write-Output "别用 git commit"` 这种完全无害的命令都会被拒。
 *   * **识别不了就放行**：别名、函数包装、多层字符串嵌套都能绕过；guard 是**约束**不是沙箱，
 *     真正的保证来自"提交信息由工具拼装"这件事本身。
 *
 * 想恢复成"只允许只读命令"的严格模式，见 `lib/git.mjs` 的 `shellGuard` 说明：那是另一个策略，
 * 不属于本模块的默认行为。
 */

/** 会产生提交信息、因而不允许在 shell 里执行的子命令。 */
export const COMMIT_SUBCOMMANDS = new Set(['commit', 'commit-tree', 'merge'])

/** git 自身的、会吃掉一个值的全局选项（`git -C <path> commit` / `git -c k=v commit`）。 */
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

/**
 * 取出 git 调用里的子命令（跳过 `-C <path>` / `-c k=v` / `--no-pager` 之类的全局选项）。
 *
 * @param args - 不含 `git` 本身的参数数组，如 `['-C', 'repo', 'commit', '-m', 'x']`。
 * @returns 子命令名；没有子命令（`git --version`）返回 null。
 */
export function gitSubcommand(args) {
  const tokens = Array.isArray(args) ? args.map((item) => String(item)) : []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') return null
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
    return token
  }
  return null
}

/**
 * 判断一次 git 调用是否会被拦下。
 *
 * @param args - 不含 `git` 本身的参数数组。
 * @returns `{ blocked, subcommand }`；`subcommand` 为 null 表示没有子命令。
 */
export function classifyGitArgs(args) {
  const subcommand = gitSubcommand(args)
  if (subcommand === null) return { blocked: false, subcommand: null }
  return { blocked: COMMIT_SUBCOMMANDS.has(subcommand), subcommand }
}

/**
 * 在一条 shell 命令文本里查找会被拦下的 git 调用。
 *
 * @param command - pwsh / bash 的 `command` 原文。
 * @returns 命中时返回 `{ subcommand, segment }`，否则 null。
 */
export function detectShellGitBlock(command) {
  if (typeof command !== 'string' || command.trim() === '') return null
  return scan(command, 0)
}

/** 旧名（0.2.x）：语义相同，保留给已发布的调用方。 */
export const detectShellGitWrite = detectShellGitBlock

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
      if (verdict.blocked) return { subcommand: verdict.subcommand, segment: segment.trim() }
      continue
    }

    if (WRAPPERS.has(base)) {
      const nested = scan(tokens.slice(index + 1).join(' '), depth + 1)
      if (nested !== null) return nested
      const match = /\bgit(?:\.exe)?\b[^A-Za-z0-9_-]*((?:-[^\s"']+\s+)*)([a-z][a-z-]*)/i.exec(segment)
      if (match !== null) {
        const headTokens = match[1].trim() === '' ? [match[2]] : [...match[1].trim().split(/\s+/), match[2]]
        const verdict = classifyGitArgs(headTokens)
        if (verdict.blocked) return { subcommand: verdict.subcommand, segment: segment.trim() }
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
