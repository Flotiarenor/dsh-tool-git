// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * git.mjs —— dsh 模型工具插件：`git` / `git_commit`，外加一段提交规范提示词与一道 shell 拦截。
 *
 * 要解决的问题：模型提交时爱用 `pwsh` 敲 `git commit -m "改了下 xx"`。这条路有三个毛病——
 * 信息内容是模型现编的（口语化、格式随意）、信息文本要过一次 shell（引号/换行/编码都能出错）、
 * 规范只存在于提示词里（没有任何东西在检查它）。
 *
 * 本插件的做法是把"提交"这件事从 shell 搬到工具里：
 *
 *   1. `git_commit` 的入参是**结构化字段**（type / scope / subject / body / breaking / footers），
 *      提交信息由 `lib/message.mjs` 拼装，经 `lib/conventions.mjs` 的规则校验；不合规**拒绝提交**
 *      并给出 code + 原因 + 改法。信息经 `git commit -F -` 的 stdin 进入 git，不经过任何 shell。
 *   2. `git` 工具把常用子命令收进白名单，参数具名、argv 由插件拼装；`commit` **不在这里**。
 *   3. `ctx.tools.guard` 只拦一条：pwsh/bash 里会产生提交信息的命令（`commit` / `merge` /
 *      `commit-tree`）。其余 git 命令照常在 shell 里跑——把工具没有的动作也一并拦掉只会让人撞墙，
 *      收益是负的（`shellGuard: 'off'` 可整体关掉）。
 *   4. `ctx.systemPrompt.section` 注入两段：工具用法 + **当前仓库实际生效的提交规范**
 *      （默认 Conventional Commits，可被 `.dsh/commit-conventions.md` 覆盖）。
 *
 * 与原生工具的关系：注册的是两个**不与原生工具重名**的工具，原生 pwsh/bash 原样保留（只多一道 guard），
 * 因此回退就是给 preset 行加 `disabled: true`。
 *
 * 依赖：**零**。只用 `node:` 内置模块——不 import 任何包，没有构建步骤、没有第三方依赖。
 * git 进程优先通过可选的宿主服务 `ctx.subprocess` 启动，服务缺席时退回 `node:child_process`。
 * preset 行的 `config:` 原样透传（本插件没有 Config schema）。
 *
 * 配置：
 *   timeoutMs: number              默认 120000；单次 git 调用的墙钟上限
 *   maxOutputBytes: number         默认 65536；单次输出上限，超出即截断并报告溢出文件
 *   spillBytes: number             默认 4194304；宿主溢出文件上限
 *   guidance: 'full' | 'short' | false   默认 'full'；false 则不注册工具用法段
 *   conventions: 'repo' | 'builtin'      默认 'repo'；builtin 表示不读仓库内规范文件
 *   conventionsFiles: string[]     覆盖默认的仓库内规范文件查找顺序
 *   maxProseBytes: number          默认 4096；仓库内规范文件的自由文本上限
 *   shellGuard: 'write' | 'off'    默认 'write'；off 则不注册 shell 拦截
 *   guardTools: string[]           默认 ['pwsh', 'bash']；拦截哪些工具
 *   allowNoVerify: boolean         默认 false；是否允许 git_commit 传 no_verify 跳过 hooks
 *   rules: { ... }                 覆盖内置规范的全局默认（types/scopes/subjectMaxColumns/...）
 */

import { existsSync, statSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import {
  CONVENTIONS_FILES,
  DEFAULT_CONVENTIONS,
  loadConventions,
  renderConventions,
} from './conventions.mjs'
import { composeMessage, lintCommit } from './message.mjs'
import { detectShellGitBlock } from './shellgit.mjs'
import { actionKinds, actionNames, actionSummaries, buildPlan, planKind } from './commands.mjs'
import { createExecutor } from './exec.mjs'

export const name = 'tool-git'

/** 只消费宿主服务（工具注册表 / 系统提示词）；subprocess 是可选消费，走 `ctx.get`。 */
export const inject = ['tools', 'systemPrompt']

const GIT_TOOL = 'git'
const COMMIT_TOOL = 'git_commit'
const USAGE_SECTION = 'tool:git'
const CONVENTIONS_SECTION = 'git:commit-conventions'
const USAGE_ORDER = 118
const CONVENTIONS_ORDER = 119
const RULE_KEYS = new Set([
  'types',
  'scopes',
  'requireScope',
  'subjectMaxColumns',
  'subjectSoftColumns',
  'bodyMaxColumns',
  'bodyConfirmChars',
  'bodySoftChars',
  'language',
  'subjectLowerCase',
  'requireBody',
  'allowEmoji',
  'firstPerson',
  'banned',
])
const CONFIG_KEYS = new Set([
  'timeoutMs',
  'maxOutputBytes',
  'spillBytes',
  'guidance',
  'conventions',
  'conventionsFiles',
  'maxProseBytes',
  'shellGuard',
  'guardTools',
  'allowNoVerify',
  'rules',
])
const COMMIT_FIELDS = new Set([
  'type',
  'scope',
  'subject',
  'body',
  'breaking',
  'footers',
  'paths',
  'all',
  'update',
  'amend',
  'signoff',
  'no_verify',
  'allow_empty',
  'dry_run',
  'confirm_length',
  'cwd',
])

/** shell 拦截时给出的替代调用：拦下的就这三个子命令，每个都有确切的替代写法。 */
const SHELL_SUGGESTIONS = {
  commit: '`git_commit({ type, scope, subject, body, paths })`',
  'commit-tree': '`git_commit({ type, scope, subject, body, paths })`',
  merge: '`git({ action: "merge", ref, noFf })`, or `git_commit` once the conflicts are resolved',
}

function readPositiveInt(raw, label, minimum, maximum, fallback) {
  if (raw === undefined || raw === null) return fallback
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
    throw new Error(`tool-git: ${label} must be an integer in [${minimum}, ${maximum}], got ${JSON.stringify(raw)}`)
  }
  return raw
}

function readRules(raw) {
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tool-git: rules must be an object')
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) {
      throw new Error(`tool-git: rules.${key} is not a known rule (known: ${[...RULE_KEYS].join(', ')})`)
    }
  }
  if (raw.types !== undefined && (!Array.isArray(raw.types) || raw.types.some((item) => typeof item !== 'string'))) {
    throw new Error('tool-git: rules.types must be an array of strings')
  }
  if (raw.scopes !== undefined && (!Array.isArray(raw.scopes) || raw.scopes.some((item) => typeof item !== 'string'))) {
    throw new Error('tool-git: rules.scopes must be an array of strings')
  }
  if (raw.banned !== undefined && (!Array.isArray(raw.banned) || raw.banned.some((item) => typeof item !== 'string'))) {
    throw new Error('tool-git: rules.banned must be an array of strings')
  }
  if (raw.language !== undefined && !['any', 'zh', 'en'].includes(raw.language)) {
    throw new Error('tool-git: rules.language must be any | zh | en')
  }
  return raw
}

/** 校验并归一 preset 行的 config。写错的配置是启动期错误，不静默兜底。 */
export function readSettings(config) {
  const raw = config === undefined || config === null ? {} : config
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tool-git: config must be an object')
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new Error(`tool-git: config.${key} is not a known setting (known: ${[...CONFIG_KEYS].join(', ')})`)
    }
  }
  const guidance = raw.guidance === undefined ? 'full' : raw.guidance
  if (!['full', 'short', false].includes(guidance)) {
    throw new Error(`tool-git: guidance must be full | short | false, got ${JSON.stringify(raw.guidance)}`)
  }
  const shellGuard = raw.shellGuard === undefined ? 'commit' : raw.shellGuard
  if (!['commit', 'off'].includes(shellGuard)) {
    throw new Error(`tool-git: shellGuard must be "commit" (block git commit/merge/commit-tree in pwsh+bash) or "off", got ${JSON.stringify(raw.shellGuard)}`)
  }
  const conventions = raw.conventions === undefined ? 'repo' : raw.conventions
  if (!['repo', 'builtin'].includes(conventions)) {
    throw new Error(`tool-git: conventions must be repo | builtin, got ${JSON.stringify(raw.conventions)}`)
  }
  const guardTools = raw.guardTools === undefined ? ['pwsh', 'bash'] : raw.guardTools
  if (!Array.isArray(guardTools) || guardTools.some((item) => typeof item !== 'string')) {
    throw new Error('tool-git: guardTools must be an array of tool names')
  }
  const conventionsFiles = raw.conventionsFiles === undefined ? CONVENTIONS_FILES : raw.conventionsFiles
  if (!Array.isArray(conventionsFiles) || conventionsFiles.some((item) => typeof item !== 'string')) {
    throw new Error('tool-git: conventionsFiles must be an array of relative paths')
  }
  return {
    timeoutMs: readPositiveInt(raw.timeoutMs, 'timeoutMs', 1_000, 3_600_000, 120_000),
    maxOutputBytes: readPositiveInt(raw.maxOutputBytes, 'maxOutputBytes', 1_024, 8 * 1024 * 1024, 64 * 1024),
    spillBytes: readPositiveInt(raw.spillBytes, 'spillBytes', 1_024, 512 * 1024 * 1024, 4 * 1024 * 1024),
    maxProseBytes: readPositiveInt(raw.maxProseBytes, 'maxProseBytes', 0, 64 * 1024, 4_096),
    guidance,
    conventions,
    conventionsFiles,
    shellGuard,
    guardTools,
    allowNoVerify: raw.allowNoVerify === true,
    rules: readRules(raw.rules),
  }
}

/** 从 agent / assemble scope 里取会话工作目录；形状不对就当没有。 */
function cwdOf(source) {
  const session = source !== null && source !== undefined && typeof source === 'object' ? source.session : undefined
  const header = session !== null && session !== undefined && typeof session === 'object' ? session.header : undefined
  const cwd = header !== null && header !== undefined && typeof header === 'object' ? header.cwd : undefined
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}

function resolveCwd(requested, fallback) {
  if (typeof requested !== 'string' || requested.trim() === '') return fallback
  const text = requested.trim()
  return isAbsolute(text) ? text : resolve(fallback, text)
}

function gitActionKind(action) {
  return actionKinds().get(action) ?? 'write'
}

function buildGitDescription() {
  const kinds = actionKinds()
  const group = (wanted) => [...kinds.entries()].filter(([, kind]) => kind === wanted).map(([action]) => action).sort()
  const summaries = new Map(actionSummaries().map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]))
  const render = (list) => list.map((action) => `  ${action}: ${summaries.get(action) ?? ''}`).join('\n')
  return [
    'Run one Git operation in the session repository through named arguments instead of a shell: the argv is built by this tool, so paths with spaces, quoting and multi-line values cannot break, and only whitelisted subcommands can run.',
    '',
    `read actions:\n${render(group('read'))}`,
    `write actions:\n${render(group('write'))}`,
    `read or write depending on the arguments:\n${render(group('mixed'))}`,
    '',
    'fields: cwd (defaults to the session directory), paths (pathspecs, appended after `--`), ref (revision/branch/tag/range), flags (per-action allowlist; an unknown, denied or duplicating flag is refused with the allowed list), plus the action-specific fields named above.',
    'output: raw git output, capped at maxOutputBytes; `truncated` and the spill file path are reported when it overflows.',
    'Committing is NOT an action here: use `git_commit`, which composes and validates the message.',
  ].join('\n')
}

function buildCommitDescription(rules) {
  const types = rules === undefined ? DEFAULT_CONVENTIONS.types : rules.types
  return [
    'Create one commit whose message this tool composes from structured fields, so the repository history keeps a single format and no prose reaches git through a shell.',
    `type is required and must be one of the project\'s types (default: ${types.join(', ')}); subject is required and must be a headline, not a sentence.`,
    'The message is validated BEFORE anything is written: an over-wide subject, a trailing period, colloquial filler, a placeholder subject, a malformed trailer or a bypassed hook is REFUSED with the reason and the fix — nothing is silently rewritten.',
    'dry_run: true composes and validates without committing, and returns the message. Staging: pass paths, or all/update; the tool reports what it staged and refuses when nothing would be committed. Hooks always run.',
  ].join(' ')
}

function buildUsageText() {
  return [
    'Commits go through `git_commit`, never through a shell: a pwsh/bash call that runs `git commit`, `git merge` or `git commit-tree` is refused by policy, because those are the commands that would put a hand-written message into history.',
    '- commit: git_commit({ type, scope, subject, body, breaking, footers, paths }) — the message is composed from those fields and validated before anything is written.',
    '- repository work: git({ action: "status" | "diff" | "log" | "show" | "blame" | "branch" | "rev_parse" | "ls_files" | "stash_list" | "remote" | "config_get" | "version" | "add" | "restore" | "switch" | "stash" | "fetch" | "pull" | "push" | "merge" | "revert" | "cherry_pick" | "reset" | "rm" | "mv" | "tag" | "clean" | "clone" | "init", ... }) — named arguments, and the argv is built by the tool so paths and quoting cannot break.',
    'Other git commands are allowed in the shell (rebase, submodule, lfs, worktree, bisect, apply, …); prefer the tool when an action exists, because it is the same operation with named arguments and no quoting.',
  ].join('\n')
}

function buildShortUsageText() {
  return 'Commits go through `git_commit` (the message is composed from type/scope/subject/body and validated before it is written); `git commit`, `git merge` and `git commit-tree` are refused in a shell. Other git commands may run in the shell, but the `git` tool is the same operation with named arguments.'
}

/** 工具值形状：每个字段都是必填的非空类型，渲染只读这些字段。 */
const GIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    code: { type: 'number' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
    spill: { type: 'string' },
    refused: { type: 'string' },
    failure: { type: 'string' },
    hint: { type: 'string' },
  },
  required: ['ok', 'action', 'code', 'command', 'cwd', 'stdout', 'stderr', 'truncated', 'spill', 'refused', 'failure', 'hint'],
}

const COMMIT_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean' },
    action: { type: 'string' },
    committed: { type: 'boolean' },
    dryRun: { type: 'boolean' },
    sha: { type: 'string' },
    message: { type: 'string' },
    problems: { type: 'array', items: { type: 'string' } },
    warnings: { type: 'array', items: { type: 'string' } },
    code: { type: 'number' },
    command: { type: 'string' },
    cwd: { type: 'string' },
    stdout: { type: 'string' },
    stderr: { type: 'string' },
    truncated: { type: 'boolean' },
    spill: { type: 'string' },
    refused: { type: 'string' },
    failure: { type: 'string' },
    hint: { type: 'string' },
  },
  required: ['ok', 'action', 'committed', 'dryRun', 'sha', 'message', 'problems', 'warnings', 'code', 'command', 'cwd', 'stdout', 'stderr', 'truncated', 'spill', 'refused', 'failure', 'hint'],
}

const GIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: actionNames(),
      description: 'The git subcommand to run; the action decides which other fields are read.',
    },
    cwd: { type: 'string', description: 'Repository directory; a relative value resolves against the session directory. Defaults to the session directory.' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Pathspecs (files or directories), appended to the argv after `--`.' },
    ref: { type: 'string', description: 'Revision, branch, tag or range: HEAD, HEAD~2, main, origin/main, v1.2.0, main...feature.' },
    refs: { type: 'array', items: { type: 'string' }, description: 'Several revisions (revert, cherry_pick).' },
    limit: { type: 'number', description: 'log: how many commits to return (default 20, max 1000).' },
    mode: { type: 'string', description: 'reset: soft|mixed|hard. stash: push|pop|apply|drop|list|show.' },
    staged: { type: 'boolean', description: 'diff: diff the index instead of the working tree. restore: unstage instead of discarding.' },
    stat: { type: 'boolean', description: 'diff/show: add --stat.' },
    nameOnly: { type: 'boolean', description: 'diff/show: list changed paths only.' },
    context: { type: 'number', description: 'diff: context lines (--unified=N).' },
    branch: { type: 'string', description: 'switch/pull/push/clone: the branch name (clone: --branch).' },
    url: { type: 'string', description: 'clone: the repository to clone — https://, ssh://, git://, file://, git@host:path, or a local path. Transport helpers such as ext:: are refused.' },
    dir: { type: 'string', description: 'clone: the target directory; a relative value resolves against the session directory. Defaults to the repository name.' },
    depth: { type: 'number', description: 'clone: shallow history depth (--depth).' },
    create: { type: 'boolean', description: 'switch: create the branch (-c).' },
    startPoint: { type: 'string', description: 'switch with create: the start point revision.' },
    remote: { type: 'string', description: 'fetch/pull/push: the remote name.' },
    force: { type: 'string', enum: ['none', 'with-lease', 'force'], description: 'push: none (default), with-lease (safe force) or force.' },
    tags: { type: 'boolean', description: 'fetch/push: include tags.' },
    prune: { type: 'boolean', description: 'fetch: prune deleted remote refs.' },
    all: { type: 'boolean', description: 'add: stage every change (-A). fetch: every remote. branch: include remotes.' },
    update: { type: 'boolean', description: 'add: stage tracked files only (-u).' },
    message: { type: 'string', description: 'merge/tag: the message text. Commits do not use this field — git_commit does.' },
    source: { type: 'string', description: 'restore: restore from this revision (--source).' },
    since: { type: 'string', description: 'log: only commits after this date.' },
    author: { type: 'string', description: 'log: only commits by this author pattern.' },
    grep: { type: 'string', description: 'log: only commits whose message matches.' },
    key: { type: 'string', description: 'config_get: the config key, e.g. "user.name".' },
    includeUntracked: { type: 'boolean', description: 'stash push: also stash untracked files.' },
    keepIndex: { type: 'boolean', description: 'stash push: keep the index.' },
    noFf: { type: 'boolean', description: 'merge: always create a merge commit.' },
    noCommit: { type: 'boolean', description: 'revert/cherry_pick: apply without committing.' },
    mainline: { type: 'number', description: 'cherry_pick: the parent number for a merge commit.' },
    confirm: { type: 'boolean', description: 'reset with mode hard, and clean without dry_run, require confirm: true.' },
    dryRun: { type: 'boolean', description: 'clean: preview only (default true).' },
    recursive: { type: 'boolean', description: 'rm: recurse into directories.' },
    cached: { type: 'boolean', description: 'rm: remove from the index only.' },
    from: { type: 'string', description: 'mv: the current path.' },
    to: { type: 'string', description: 'mv: the new path.' },
    name: { type: 'string', description: 'tag: the tag name; without it the action lists tags.' },
    delete: { type: 'boolean', description: 'tag: delete the named tag.' },
    list: { type: 'boolean', description: 'tag: list tags.' },
    abort: { type: 'boolean', description: 'merge: abort the in-progress merge.' },
    continue: { type: 'boolean', description: 'merge: continue after resolving conflicts.' },
    detach: { type: 'boolean', description: 'switch: detach HEAD.' },
    bare: { type: 'boolean', description: 'init: create a bare repository.' },
    setUpstream: { type: 'boolean', description: 'push: set the upstream branch (-u).' },
    flags: {
      type: 'array',
      items: { type: 'string' },
      description: 'Extra flags, validated against a per-action allowlist. Flags that change git\'s execution environment or duplicate a named field (-c, -C, --git-dir, -m, --amend, --output, --no-verify, ...) are refused.',
    },
  },
  required: ['action'],
}

const COMMIT_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', description: 'Conventional Commits type, e.g. feat, fix, docs, refactor, perf, test, build, ci, chore, revert. The action validates it against the project rules.' },
    scope: { type: 'string', description: 'Optional area, lowercase, no spaces, e.g. "parser" or "core/http".' },
    subject: { type: 'string', description: 'Required headline: what changed, imperative, no trailing period, no filler, one line. The type prefix is added by the tool.' },
    body: { type: 'string', description: 'Optional body: why the change is made, wrapped, blank line between paragraphs, "- " for bullets.' },
    breaking: { type: 'string', description: 'Describe the breaking change; the tool adds the "!" marker and the "BREAKING CHANGE:" trailer.' },
    footers: { type: 'array', items: { type: 'string' }, description: 'Git trailers, e.g. "Refs: #123", "Closes #42", "Co-authored-by: Name <mail>".' },
    paths: { type: 'array', items: { type: 'string' }, description: 'Stage exactly these paths before committing.' },
    all: { type: 'boolean', description: 'Stage every change (-A) before committing.' },
    update: { type: 'boolean', description: 'Stage tracked changes (-u) before committing.' },
    amend: { type: 'boolean', description: 'Amend the previous commit with this message.' },
    signoff: { type: 'boolean', description: 'Add a Signed-off-by trailer.' },
    no_verify: { type: 'boolean', description: 'Skip hooks (refused unless the profile allows it).' },
    allow_empty: { type: 'boolean', description: 'Commit even when nothing is staged.' },
    confirm_length: { type: 'boolean', description: 'Confirm a body longer than the project\'s confirmation threshold (bodyConfirmChars). Prefer shortening; use this only when every paragraph carries a fact the code cannot show.' },
    dry_run: { type: 'boolean', description: 'Compose and validate only: return the message without committing.' },
    cwd: { type: 'string', description: 'Repository directory; defaults to the session directory.' },
  },
  required: ['type', 'subject'],
}

function renderFailedLines(value) {
  const lines = []
  const stderr = value.stderr.trim()
  const stdout = value.stdout.trim()
  if (stderr !== '') lines.push(stderr)
  if (stdout !== '') lines.push(lines.length === 0 ? stdout : `[stdout]\n${stdout}`)
  if (lines.length === 0) lines.push('(git produced no output)')
  if (value.truncated) lines.push(`[output truncated${value.spill === '' ? '' : `; full output: ${value.spill}`}]`)
  return lines
}

function renderGitResult(_args, value) {
  if (value.refused !== '') return [{ type: 'text', text: `REFUSED\n${value.refused}` }]
  const lines = []
  if (value.failure !== '') lines.push(`FAIL ${value.action}\n${value.failure}`)
  else if (!value.ok) lines.push(`FAIL ${value.action} (exit ${value.code})`)
  if (!value.ok || value.failure !== '') {
    lines.push(...renderFailedLines(value))
  } else {
    const stdout = value.stdout.trim()
    lines.push(stdout === '' ? `OK ${value.action} (no output)` : stdout)
    const stderr = value.stderr.trim()
    if (stderr !== '') lines.push(`[stderr]\n${stderr}`)
    if (value.truncated) {
      lines.push(`[output truncated${value.spill === '' ? '' : `; full output: ${value.spill}`}]`)
    }
  }
  if (value.hint !== '') lines.push(`[hint] ${value.hint}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function renderCommitResult(_args, value) {
  if (value.refused !== '') {
    const lines = ['REFUSED', value.refused]
    if (value.problems.length > 0) lines.push(...value.problems.map((line) => `- ${line}`))
    if (value.warnings.length > 0) lines.push(...value.warnings.map((line) => `[warning] ${line}`))
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const lines = []
  if (value.failure !== '') lines.push(`FAIL commit\n${value.failure}`)
  else if (!value.ok) lines.push(`FAIL commit (exit ${value.code})`)
  if (value.dryRun && value.ok) {
    lines.push('DRY-RUN: nothing was committed. The message below passed validation:')
    lines.push(value.message.trimEnd())
  } else if (value.committed) {
    lines.push(`COMMITTED ${value.sha}`)
    lines.push(value.message.trimEnd())
    const stdout = value.stdout.trim()
    if (stdout !== '') lines.push(stdout)
  } else if (!value.ok) {
    lines.push(...renderFailedLines(value))
  }
  if (value.warnings.length > 0) lines.push(...value.warnings.map((line) => `[warning] ${line}`))
  if (value.hint !== '') lines.push(`[hint] ${value.hint}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/** 从 git 的失败输出里挑出最可能的下一步；只加一行，不猜太多。 */
function classifyFailure(stderr) {
  const text = stderr.toLowerCase()
  if (text.includes('not a git repository')) return 'This directory is not inside a git work tree; run git({ action: "init" }) or point `cwd` at the repository.'
  if (text.includes('nothing to commit')) return 'There was nothing staged; stage with paths/all/update before committing.'
  if (text.includes('no upstream branch') || text.includes('has no upstream')) return 'The branch has no upstream; push with setUpstream: true.'
  if (text.includes('conflict') || text.includes('unmerged')) return 'Conflicts must be resolved first; then continue with merge: { continue: true } or commit the resolution.'
  if (text.includes('hook') || text.includes('husky') || text.includes('lint-staged')) return 'A git hook rejected the operation; fix the reported problem — bypassing hooks is refused.'
  if (text.includes('authentication failed') || text.includes('could not read username') || text.includes('permission denied')) return 'Authentication failed and interactive prompts are disabled; the user has to fix credentials.'
  if (text.includes('did not match any file')) return 'The revision or path does not exist; check `ref` and `paths`.'
  return ''
}

/** shell 拦截的拒绝文案：说清拦的是哪条、为什么、该用什么。 */
function guardMessage(hit, toolName) {
  const suggestion = SHELL_SUGGESTIONS[hit.subcommand]
  return [
    `git ${hit.subcommand} is refused in ${toolName}: it writes a commit message, and messages are composed and validated by the \`git_commit\` tool.`,
    suggestion === undefined ? 'Use `git_commit({ type, scope, subject, body, paths })` instead.' : `Use ${suggestion} instead.`,
    'Only commit/merge/commit-tree are refused; every other git command runs in the shell as usual.',
  ].join('\n')
}

/**
 * 注册两个工具、两段提示词与 shell 拦截。
 * @param ctx - 插件上下文（注册随其 fiber 释放）。
 * @param config - preset 行配置（见文件头注释）。
 */
export function apply(ctx, config) {
  const settings = readSettings(config)
  const executor = createExecutor(ctx, {
    timeoutMs: settings.timeoutMs,
    maxOutputBytes: settings.maxOutputBytes,
    spillBytes: settings.spillBytes,
  })
  const conventionsOptions = {
    rules: settings.rules,
    files: settings.conventionsFiles,
    maxProseBytes: settings.maxProseBytes,
    discover: settings.conventions !== 'builtin',
  }

  function conventionsFor(cwd) {
    return loadConventions(cwd, conventionsOptions)
  }

  function emptyValue(action, extra) {
    return {
      ok: false,
      action,
      code: -1,
      command: '',
      cwd: '',
      stdout: '',
      stderr: '',
      truncated: false,
      spill: '',
      refused: '',
      failure: '',
      hint: '',
      ...extra,
    }
  }

  function emptyCommitValue(extra) {
    return {
      ok: false,
      action: 'commit',
      committed: false,
      dryRun: false,
      sha: '',
      message: '',
      problems: [],
      warnings: [],
      code: -1,
      command: '',
      cwd: '',
      stdout: '',
      stderr: '',
      truncated: false,
      spill: '',
      refused: '',
      failure: '',
      hint: '',
      ...extra,
    }
  }

  async function executeGit(argv, cwd, signal) {
    return await executor.run({ argv, cwd, signal })
  }

  if (settings.guidance !== false) {
    ctx.systemPrompt.section({
      name: USAGE_SECTION,
      order: USAGE_ORDER,
      text: settings.guidance === 'short' ? buildShortUsageText() : buildUsageText(),
    })
  }

  // 规范段是**动态**的：同一进程里不同会话可能在不同仓库，规则随会话目录变化。
  // 渲染失败不能炸掉整次装配，所以这里兜到底：出错就退回"内置默认规则"。
  ctx.systemPrompt.section({
    name: CONVENTIONS_SECTION,
    order: CONVENTIONS_ORDER,
    text: (context) => {
      const scope = context !== null && context !== undefined ? context.scope : undefined
      const cwd = cwdOf(scope) ?? process.cwd()
      try {
        return renderConventions(conventionsFor(cwd))
      } catch (error) {
        try {
          return renderConventions(loadConventions(cwd, { ...conventionsOptions, discover: false }))
        } catch {
          return `Commit messages are composed and validated by git_commit. Rules could not be loaded (${String(error && error.message ? error.message : error)}); fall back to Conventional Commits: <type>(<scope>): <subject>, subject at most 72 display columns, no trailing period, no colloquial filler.`
        }
      }
    },
  })

  ctx.tools.register({
    name: GIT_TOOL,
    description: buildGitDescription(),
    parameters: GIT_PARAMETERS,
    output: { schema: GIT_OUTPUT, render: renderGitResult },
    timeoutMs: settings.timeoutMs + 5_000,
    isConcurrencySafe: (args) => planKind(args) === 'read',
    presentCall(args) {
      const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : ''
      const detail = args !== null && typeof args === 'object'
        ? Object.entries(args)
          .filter(([key, value]) => key !== 'action' && value !== undefined && value !== null)
          .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(' ') : String(value)}`)
          .join(' ')
        : ''
      return { card: 'terminal', title: `git ${action}`.trim(), description: detail.slice(0, 200) }
    },
    presentResult(args, result) {
      const action = args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : ''
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
      return {
        card: 'terminal',
        title: `git ${action}`.trim(),
        output: output.slice(0, 4_000),
        exitCode: typeof result.code === 'number' ? result.code : undefined,
      }
    },
    async execute(args, runCtx) {
      const fallbackCwd = cwdOf(runCtx !== null && runCtx !== undefined ? runCtx.agent : undefined) ?? process.cwd()
      const plan = buildPlan(args, { defaultDir: fallbackCwd })
      if (!plan.ok) {
        return emptyValue(
          args !== null && typeof args === 'object' && typeof args.action === 'string' ? args.action : '',
          { cwd: fallbackCwd, refused: plan.errors.map((item) => `${item.message}${item.hint === '' ? '' : ` — ${item.hint}`}`).join('\n') },
        )
      }
      const cwd = resolveCwd(plan.cwd, fallbackCwd)
      if (!existsSync(cwd)) {
        return emptyValue(plan.action, { cwd, refused: `the working directory ${JSON.stringify(cwd)} does not exist.` })
      }
      let info
      try {
        info = statSync(cwd)
      } catch {
        info = null
      }
      if (info === null || !info.isDirectory()) {
        return emptyValue(plan.action, { cwd, refused: `${JSON.stringify(cwd)} is not a directory.` })
      }
      const outcome = await executeGit(['git', ...plan.argv], cwd, runCtx === undefined ? undefined : runCtx.signal)
      const base = {
        action: plan.action,
        code: outcome.exitCode === null ? -1 : outcome.exitCode,
        command: plan.display,
        cwd,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        truncated: outcome.truncated,
        spill: outcome.spillPath,
        failure: outcome.failure,
        hint: '',
      }
      if (outcome.failure !== '') {
        return emptyValue(plan.action, { ...base, hint: outcome.timedOut ? `the call exceeded ${settings.timeoutMs} ms and was terminated.` : '' })
      }
      if (outcome.exitCode !== 0) {
        return emptyValue(plan.action, { ...base, hint: classifyFailure(outcome.stderr) })
      }
      return emptyValue(plan.action, { ...base, ok: true })
    },
  })

  ctx.tools.register({
    name: COMMIT_TOOL,
    description: buildCommitDescription(settings.rules),
    parameters: COMMIT_PARAMETERS,
    output: { schema: COMMIT_OUTPUT, render: renderCommitResult },
    timeoutMs: settings.timeoutMs + 5_000,
    isConcurrencySafe: () => false,
    presentCall(args) {
      const values = args !== null && typeof args === 'object' ? args : {}
      let title = 'git commit'
      try {
        const head = `${values.type ?? '?'}${typeof values.scope === 'string' && values.scope !== '' ? `(${values.scope})` : ''}: ${values.subject ?? ''}`
        title = `git commit: ${head}`.slice(0, 200)
      } catch {
        /* 预览失败不影响调用 */
      }
      return { card: 'terminal', title, description: values.dry_run === true ? 'dry run' : '' }
    },
    presentResult(_args, result) {
      const output = result.committed
        ? `${result.sha} ${result.message.split('\n')[0] ?? ''}`.trim()
        : `${result.refused || result.stderr || result.message}`.trim()
      return {
        card: 'terminal',
        title: result.committed ? 'git commit' : 'git commit (refused)',
        output: output.slice(0, 4_000),
        exitCode: typeof result.code === 'number' ? result.code : undefined,
      }
    },
    async execute(args, runCtx) {
      const values = args !== null && typeof args === 'object' ? args : {}
      const fallbackCwd = cwdOf(runCtx !== null && runCtx !== undefined ? runCtx.agent : undefined) ?? process.cwd()
      const cwd = resolveCwd(values.cwd, fallbackCwd)
      const signal = runCtx === undefined ? undefined : runCtx.signal

      for (const key of Object.keys(values)) {
        if (!COMMIT_FIELDS.has(key)) {
          return emptyCommitValue({
            cwd,
            refused: `${JSON.stringify(key)} is not a field of this tool; use ${[...COMMIT_FIELDS].sort().join(', ')}.`,
          })
        }
      }
      if (values.no_verify === true && !settings.allowNoVerify) {
        return emptyCommitValue({
          cwd,
          refused: 'no_verify is refused: hooks are part of the project\'s quality gate. Fix what the hook reports; the hook output is returned verbatim.',
        })
      }
      if (!existsSync(cwd)) {
        return emptyCommitValue({ cwd, refused: `the working directory ${JSON.stringify(cwd)} does not exist.` })
      }

      let resolved
      try {
        resolved = conventionsFor(cwd)
      } catch (error) {
        return emptyCommitValue({
          cwd,
          refused: `the project conventions could not be loaded: ${String(error && error.message ? error.message : error)}`,
        })
      }

      const lint = lintCommit(values, resolved.rules, { confirmLength: values.confirm_length === true })
      const problems = lint.errors.map((item) => `[${item.code}] ${item.message}${item.hint === '' ? '' : ` — ${item.hint}`}`)
      const warnings = lint.warnings.map((item) => `[${item.code}] ${item.message}${item.hint === '' ? '' : ` — ${item.hint}`}`)
      const message = lint.message
      if (lint.errors.length > 0) {
        return emptyCommitValue({
          cwd,
          message,
          problems,
          warnings,
          refused: `the commit message does not satisfy the project rules (${resolved.source === null ? 'built-in Conventional Commits rules' : resolved.source}). Nothing was staged or committed.`,
        })
      }
      if (values.dry_run === true) {
        return emptyCommitValue({ ok: true, dryRun: true, cwd, message, warnings })
      }

      // 1. 先确认在仓库里，失败信息比 add 的报错清楚得多。
      const check = await executeGit(['git', 'rev-parse', '--is-inside-work-tree'], cwd, signal)
      if (check.failure !== '') {
        return emptyCommitValue({ cwd, message, warnings, failure: check.failure })
      }
      if (check.exitCode !== 0) {
        return emptyCommitValue({ cwd, message, warnings, code: check.exitCode === null ? -1 : check.exitCode, stderr: check.stderr, hint: classifyFailure(check.stderr) })
      }

      // 2. 暂存：paths / all / update 三选一，之后必须真的有内容可提交。
      const paths = Array.isArray(values.paths) ? values.paths.filter((item) => typeof item === 'string' && item.trim() !== '') : []
      const stageArgv = values.all === true
        ? ['git', 'add', '-A']
        : values.update === true
          ? ['git', 'add', '-u']
          : paths.length > 0
            ? ['git', 'add', '--', ...paths]
            : null
      if (stageArgv !== null) {
        const staged = await executeGit(stageArgv, cwd, signal)
        if (staged.failure !== '' || staged.exitCode !== 0) {
          return emptyCommitValue({
            cwd,
            message,
            warnings,
            code: staged.exitCode === null ? -1 : staged.exitCode,
            command: stageArgv.join(' '),
            stdout: staged.stdout,
            stderr: staged.stderr,
            truncated: staged.truncated,
            spill: staged.spillPath,
            failure: staged.failure,
            hint: classifyFailure(staged.stderr),
          })
        }
      }

      const stagedList = await executeGit(['git', 'diff', '--cached', '--name-only'], cwd, signal)
      const hasStaged = stagedList.exitCode === 0 && stagedList.stdout.trim() !== ''
      if (!hasStaged && values.amend !== true && values.allow_empty !== true) {
        const status = await executeGit(['git', 'status', '--short', '--branch'], cwd, signal)
        return emptyCommitValue({
          cwd,
          message,
          warnings,
          refused: 'nothing is staged, so there is nothing to commit.',
          stdout: status.stdout,
          hint: 'Stage first: pass `paths`, or `all: true` / `update: true`. If the intent really is an empty commit, pass `allow_empty: true`.',
        })
      }

      // 3. 提交：信息走 stdin（`-F -`），cleanup 只做空白清理。
      const argv = ['git', 'commit', '--cleanup=whitespace', '-F', '-']
      if (values.amend === true) argv.push('--amend')
      if (values.signoff === true) argv.push('--signoff')
      if (values.allow_empty === true && !hasStaged) argv.push('--allow-empty')
      if (values.no_verify === true && settings.allowNoVerify) argv.push('--no-verify')
      const commit = await executor.run({ argv, cwd, stdin: message, signal })
      const base = {
        cwd,
        message,
        warnings,
        command: argv.join(' '),
        code: commit.exitCode === null ? -1 : commit.exitCode,
        stdout: commit.stdout,
        stderr: commit.stderr,
        truncated: commit.truncated,
        spill: commit.spillPath,
        failure: commit.failure,
      }
      if (commit.failure !== '') {
        return emptyCommitValue({ ...base, hint: commit.timedOut ? `the call exceeded ${settings.timeoutMs} ms and was terminated.` : '' })
      }
      if (commit.exitCode !== 0) {
        return emptyCommitValue({ ...base, hint: classifyFailure(commit.stderr) })
      }

      // 4. 回读一次：确认落在仓库里的信息就是拼装出来的那一条（hook 可能改写它）。
      const sha = await executeGit(['git', 'rev-parse', '--short', 'HEAD'], cwd, signal)
      const recorded = await executeGit(['git', 'log', '-1', '--pretty=%B'], cwd, signal)
      const normalize = (text) => text.replace(/\r\n?/g, '\n').split('\n').map((line) => line.replace(/\s+$/, '')).join('\n').trim()
      if (recorded.exitCode === 0 && normalize(recorded.stdout) !== normalize(message)) {
        warnings.push('[message.rewritten] a hook or git rewrote the recorded message; compare `git log -1` with the message above.')
      }
      return emptyCommitValue({
        ...base,
        ok: true,
        committed: true,
        sha: sha.exitCode === 0 ? sha.stdout.trim() : '',
      })
    },
  })

  if (settings.shellGuard !== 'off') {
    const guardTools = new Set(settings.guardTools)
    ctx.tools.guard((execution) => {
      if (execution === null || execution === undefined) return undefined
      if (!guardTools.has(execution.name)) return undefined
      const args = execution.arguments
      const command = args !== null && args !== undefined && typeof args === 'object' ? args.command : undefined
      const hit = detectShellGitBlock(command)
      if (hit === null) return undefined
      return guardMessage(hit, execution.name)
    })
  }
}

/** 供自测与量测脚本直接使用的导出（不经过 Cordis）。 */
export const internals = {
  readSettings,
  buildUsageText,
  buildGitDescription,
  buildCommitDescription,
  classifyFailure,
  guardMessage,
  GIT_PARAMETERS,
  COMMIT_PARAMETERS,
  GIT_OUTPUT,
  COMMIT_OUTPUT,
  renderGitResult,
  renderCommitResult,
  composeMessage,
  gitActionKind,
}
