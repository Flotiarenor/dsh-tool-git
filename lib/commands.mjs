// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * commands.mjs —— `git` 工具的**动作表**：白名单子命令 → argv。
 *
 * 这里是"用 git 而不是 pwsh 用 git"的落点：模型给的是**具名参数**
 * （action / paths / ref / limit / mode / …），argv 由本模块拼装，因此
 *
 *   1. 不存在 shell 引号、路径空格、通配符展开、`;` 注入这一类问题——数组传参给 git，没有中间层；
 *   2. 每个动作只接受它自己声明过的字段与旗标，其余一律带 code/hint 拒绝，模型不会"顺手多给一个 -f"；
 *   3. 少数几个危险动作（`reset --hard`、`clean`）要求显式确认，且 `clean` 默认只做 dry-run。
 *
 * 有意为之的取舍：
 *   * **不提供 `commit`**：提交走 `git_commit`（结构化字段 + 规范校验）。这里给出明确的提示，
 *     而不是一个能绕过校验的入口。
 *   * **旗标按"名字"白名单**：`--diff-filter=M` 取 `--diff-filter` 判定，值只做字符集检查。
 *     这样既不用为每个取值写一条规则，也不会放进 `--output` 这种会写文件的旗标。
 *   * **argv 总是自己拼**：`--` 由本模块加在 pathspec 之前，模型给不出"看起来像路径的旗标"。
 */

const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9._/@{}^~:+-]*$/
const BRANCH_RE = /^[^\s~^:?*[\\]+$/
const FLAG_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._+-]*$/
const FLAG_VALUE_RE = /^[A-Za-z0-9.,:_/@{}^~*+-]*$/
const SCOPE_FIELDS = new Set(['action', 'cwd', 'flags', 'paths', 'ref', 'refs', 'limit', 'mode', 'staged', 'stat', 'nameOnly', 'context', 'branch', 'create', 'startPoint', 'remote', 'force', 'tags', 'prune', 'all', 'update', 'message', 'source', 'since', 'author', 'grep', 'key', 'includeUntracked', 'keepIndex', 'noFf', 'noCommit', 'mainline', 'confirm', 'dryRun', 'recursive', 'cached', 'from', 'to', 'name', 'delete', 'list', 'abort', 'continue', 'detach', 'bare', 'setUpstream', 'url', 'dir', 'depth'])

/** 这些旗标在任何动作里都不接受：它们要么改 git 的执行环境，要么把"具名参数"旁路掉。 */
const DENIED_FLAGS = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--upload-pack',
  '--receive-pack',
  '--output',
  '--output-directory',
  '--no-verify',
  '-F',
  '--file',
  '-m',
  '--message',
  '--amend',
  '--no-index',
  '--separate-git-dir',
  '--template',
  '--ref-format',
  '-i',
  '--interactive',
  '--edit',
  '-e',
  '--paginate',
  '-p',
  '--no-pager',
])

/** 每个动作的旗标白名单（按名字比较，`=value` 只做字符集检查）。 */
const FLAGS = {
  status: ['--short', '-s', '--branch', '-b', '--porcelain', '--long', '-uall', '-uno', '-unormal', '--ignored', '--show-stash', '--no-renames', '-z', '--ahead-behind', '--no-ahead-behind', '--column'],
  diff: ['--cached', '--staged', '--stat', '--shortstat', '--numstat', '--name-only', '--name-status', '--summary', '--patch', '-p', '--no-color', '--color', '--word-diff', '--check', '--ignore-all-space', '-w', '--diff-filter', '--find-renames', '--no-renames', '--unified', '-U', '--no-ext-diff', '--text', '-a', '--submodule', '--ignore-space-change', '-b', '--ignore-blank-lines'],
  log: ['--oneline', '--graph', '--decorate', '--no-decorate', '--stat', '--shortstat', '--name-only', '--name-status', '--no-merges', '--merges', '--first-parent', '--all', '--branches', '--tags', '--remotes', '--topo-order', '--date-order', '--reverse', '--follow', '--no-color', '--color', '--pretty', '--format', '--date', '--author', '--committer', '--grep', '--since', '--until', '--max-count', '-n', '--abbrev-commit', '--no-abbrev-commit', '--patch', '-p', '--no-renames', '--diff-filter', '--cherry-pick', '--left-right'],
  show: ['--stat', '--shortstat', '--name-only', '--name-status', '--summary', '--patch', '-p', '--no-color', '--color', '--pretty', '--format', '--abbrev-commit', '--first-parent', '--no-renames', '--diff-filter', '--submodule', '--no-ext-diff', '--date', '--unified', '-U'],
  blame: ['--no-color', '-w', '--line-porcelain', '--porcelain', '-L', '--date', '--show-email', '-e', '--abbrev', '--root', '-M', '-C'],
  branch: ['-a', '--all', '-r', '--remotes', '-v', '-vv', '--list', '--show-current', '--contains', '--merged', '--no-merged', '--format', '--sort', '--no-color', '--column', '--points-at'],
  rev_parse: ['--short', '--verify', '--abbrev-ref', '--show-toplevel', '--show-prefix', '--show-cdup', '--git-dir', '--absolute-git-dir', '--git-common-dir', '--is-inside-work-tree', '--is-inside-git-dir', '--is-bare-repository', '--symbolic-full-name', '--show-superproject-working-tree', '--all', '--tags', '--branches', '--remotes'],
  ls_files: ['-m', '--modified', '-o', '--others', '-i', '--ignored', '-c', '--cached', '-d', '--deleted', '--exclude-standard', '--directory', '-s', '--stage', '--error-unmatch', '--full-name', '--unmerged', '-u'],
  stash_list: ['--stat', '--patch', '-p', '--name-only', '--oneline', '--no-color', '--format'],
  remote: ['-v', '--verbose'],
  config_get: ['--get', '--get-all', '--get-regexp', '--list', '-l', '--show-origin', '--show-scope', '--local', '--global', '--system', '--worktree', '--default', '--type', '--null', '-z', '--name-only', '--show-names'],
  version: [],
  add: ['-A', '--all', '-u', '--update', '-f', '--force', '-n', '--dry-run', '-v', '--verbose', '--ignore-removal', '--renormalize', '--intent-to-add', '-N', '--ignore-errors', '--sparse', '--chmod'],
  restore: ['--staged', '-S', '--worktree', '-W', '--source', '--ours', '--theirs', '--ignore-unmerged', '--merge', '--conflict', '--recurse-submodules', '--overlay', '--no-overlay', '--pathspec-from-file'],
  switch: ['--detach', '-d', '--force', '-f', '--track', '-t', '--no-track', '--guess', '--no-guess', '--discard-changes', '--orphan', '--merge', '-m', '--conflict', '--ignore-other-worktrees', '--recurse-submodules'],
  stash: ['--include-untracked', '-u', '--keep-index', '-k', '--staged', '-S', '--all', '-a', '--quiet', '-q', '--index', '--no-keep-index', '--patch'],
  fetch: ['--all', '--prune', '-p', '--tags', '-t', '--no-tags', '--prune-tags', '--depth', '--unshallow', '--dry-run', '--force', '-f', '--atomic', '--no-recurse-submodules', '--recurse-submodules', '--multiple', '--set-upstream', '--verbose', '-v', '--quiet', '-q', '--jobs', '-j'],
  pull: ['--rebase', '-r', '--no-rebase', '--ff-only', '--no-ff', '--ff', '--autostash', '--no-commit', '--squash', '--depth', '--unshallow', '--tags', '--no-tags', '--prune', '-p', '--verbose', '-v', '--quiet', '-q', '--allow-unrelated-histories', '--no-edit', '--recurse-submodules', '--jobs', '-j'],
  push: ['--tags', '--follow-tags', '--set-upstream', '-u', '--delete', '--all', '--dry-run', '-n', '--atomic', '--verbose', '-v', '--quiet', '-q', '--prune', '--ipv4', '--ipv6', '--force-with-lease', '--force-if-includes', '--signed', '--no-signed', '--push-option', '-o'],
  merge: ['--no-ff', '--ff', '--ff-only', '--squash', '--no-commit', '--no-edit', '--autostash', '--strategy', '-s', '--strategy-option', '-X', '--allow-unrelated-histories', '--no-squash', '--no-autostash'],
  revert: ['--no-commit', '-n', '--no-edit', '--skip', '--mainline', '--strategy', '-s', '--strategy-option', '-X', '--reference'],
  cherry_pick: ['--no-commit', '-n', '--skip', '--mainline', '--ff', '--allow-empty', '--allow-empty-message', '--keep-redundant-commits', '--strategy', '-s', '--strategy-option', '-X', '--reference', '-x'],
  reset: ['--quiet', '-q', '--pathspec-from-file', '--recurse-submodules'],
  rm: ['-r', '--recursive', '--cached', '-f', '--force', '-q', '--quiet', '--ignore-unmatch', '--dry-run', '-n', '--sparse'],
  mv: ['-f', '--force', '-k', '-v', '--verbose', '-n', '--dry-run', '--sparse'],
  tag: ['-a', '--annotate', '-s', '--sign', '-f', '--force', '-d', '--delete', '--verify', '-l', '--list', '-n', '--contains', '--points-at', '--merged', '--no-merged', '--format', '--sort', '--column'],
  clean: ['-d', '-f', '--force', '-n', '--dry-run', '-x', '-X', '--exclude', '--no-directories'],
  clone: ['--bare', '--mirror', '--depth', '--shallow-since', '--shallow-exclude', '--branch', '-b', '--no-checkout', '-n', '--filter', '--sparse', '--single-branch', '--no-single-branch', '--recurse-submodules', '--shallow-submodules', '--remote-submodules', '--jobs', '-j', '--origin', '-o', '--quiet', '-q', '--verbose', '-v', '--no-tags', '--dissociate', '--reference', '--reference-if-able', '--local', '-l', '--no-hardlinks', '--shared', '-s', '--progress', '--reject-shallow', '--also-filter-submodules'],
  init: ['--bare', '--initial-branch', '-b', '--shared', '--quiet', '-q', '--object-format'],
}

class ValidationError extends Error {
  constructor(errors) {
    super(errors[0].message)
    this.errors = errors
  }
}

function bad(code, message, hint) {
  return { code, message, hint }
}

function fail(code, message, hint) {
  throw new ValidationError([bad(code, message, hint)])
}

function value(args, key) {
  const raw = args[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'string') fail(`arg.${key}`, `${key} must be a string`, `Pass ${key} as a string.`)
  const text = raw.trim()
  return text === '' ? undefined : text
}

function boolean(args, key) {
  const raw = args[key]
  if (raw === undefined || raw === null) return false
  if (typeof raw !== 'boolean') fail(`arg.${key}`, `${key} must be a boolean`, `Pass ${key} as true or false.`)
  return raw
}

function integer(args, key, minimum, maximum) {
  const raw = args[key]
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < minimum || raw > maximum) {
    fail(`arg.${key}`, `${key} must be an integer in [${minimum}, ${maximum}]`, `Pass a whole number between ${minimum} and ${maximum}.`)
  }
  return raw
}

function list(args, key) {
  const raw = args[key]
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) fail(`arg.${key}`, `${key} must be an array of strings`, `Pass ${key} as an array.`)
  return raw.map((item) => {
    if (typeof item !== 'string') fail(`arg.${key}`, `${key} must contain only strings`, `Remove non-string entries from ${key}.`)
    return item
  })
}

function checkRef(text, label = 'ref') {
  if (text.length > 256) fail('ref.too-long', `${label} is longer than 256 characters`, `Pass a revision such as "HEAD~1", "main" or "origin/main".`)
  if (!REF_RE.test(text)) {
    fail(
      'ref.format',
      `${JSON.stringify(text)} is not a valid ${label}`,
      'A revision looks like "HEAD", "HEAD~2", "main", "origin/main", "v1.2.0" or "main...feature"; it must not start with "-" or contain spaces.',
    )
  }
  if (text.includes('..') && !/[A-Za-z0-9_^~@{}]\.\./.test(text) && !/\.\.[A-Za-z0-9_^~@{}]/.test(text)) {
    fail('ref.format', `${JSON.stringify(text)} is not a valid ${label}`, 'Write a range as "A..B" or "A...B".')
  }
  return text
}

function checkBranchName(text) {
  if (text.length > 200) fail('branch.too-long', 'branch name is longer than 200 characters', 'Use a short branch name.')
  if (!BRANCH_RE.test(text) || text.startsWith('-') || text.includes('..') || text.endsWith('/') || text.endsWith('.lock')) {
    fail(
      'branch.format',
      `${JSON.stringify(text)} is not a valid branch name`,
      'A branch name must not contain spaces or any of ~ ^ : ? * [ \\, must not start with "-", and must not contain "..".',
    )
  }
  return text
}

/**
 * 校验 clone 的来源地址。
 *
 * 这里不只是"格式好看"：git 的传输层支持 `ext::`、`fd::` 这类**传输助手**，`ext::sh -c …`
 * 会在本机执行命令。所以只放行常见的几种 scheme 与 scp 形式，并显式拒绝 `scheme::` 写法。
 */
function checkRemoteUrl(text) {
  if (text.length > 2048) fail('url.too-long', 'url is longer than 2048 characters', 'Pass a repository URL.')
  if (/[\s\r\n\0]/.test(text)) fail('url.format', 'url contains whitespace or a control character', 'URLs are single tokens without spaces.')
  if (text.startsWith('-')) fail('url.format', 'url must not start with "-"', 'Pass a repository URL, not a flag.')
  if (/^[A-Za-z][A-Za-z0-9+.-]*::/.test(text)) {
    fail(
      'url.transport',
      `${JSON.stringify(text)} uses a git transport helper`,
      'Transport helpers such as ext:: or fd:: can execute local commands; use https://, ssh://, git://, file:// or a local path.',
    )
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(text)
  if (scheme !== null) {
    const allowed = ['https', 'http', 'ssh', 'git', 'file']
    if (!allowed.includes(scheme[1].toLowerCase())) {
      fail('url.scheme', `unsupported URL scheme ${JSON.stringify(scheme[1])}`, `Use one of: ${allowed.map((item) => `${item}://`).join(', ')}, scp form (git@host:path), or a local path.`)
    }
    return text
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/.test(text)) return text
  return text
}

/** clone 的目标目录：普通路径，不允许像旗标。 */
function checkTargetDirectory(text) {
  if (text.length > 1024) fail('dir.too-long', 'dir is longer than 1024 characters', 'Pass a directory path.')
  if (/[\r\n\0]/.test(text)) fail('dir.format', 'dir contains a line break or NUL', 'Directories are single-line strings.')
  if (text.startsWith('-')) fail('dir.looks-like-flag', `${JSON.stringify(text)} starts with "-"`, 'A directory must not start with "-".')
  return text
}

function checkPathspecs(items) {
  const out = []
  for (const item of items) {
    if (typeof item !== 'string') fail('paths.format', 'paths must contain only strings', 'Pass paths as an array of strings.')
    const text = item.trim()
    if (text === '') continue
    if (text.length > 1024) fail('paths.too-long', 'a path is longer than 1024 characters', 'Pass a repository-relative path.')
    if (/[\r\n\0]/.test(text)) fail('paths.format', 'a path contains a line break or NUL', 'Paths are single-line strings.')
    if (text.startsWith('-')) fail('paths.looks-like-flag', `${JSON.stringify(text)} starts with "-"`, 'A path must not start with "-"; flags go into `flags`.')
    out.push(text)
  }
  return out
}

function checkFlags(args, action) {
  const allowed = new Set(FLAGS[action] ?? [])
  const out = []
  for (const item of list(args, 'flags')) {
    const token = item.trim()
    if (token === '') continue
    if (token.length > 128) fail('flags.too-long', `flag ${JSON.stringify(token)} is too long`, 'Pass real git flags only.')
    if (!FLAG_RE.test(token.split('=')[0]) || !/^-{1,2}[^\s]*$/.test(token)) {
      fail('flags.format', `${JSON.stringify(token)} is not a flag token`, 'A flag looks like "-a" or "--stat"; values go after "=".')
    }
    const [name, ...rest] = token.split('=')
    if (rest.length > 0 && !FLAG_VALUE_RE.test(rest.join('='))) {
      fail('flags.value', `${JSON.stringify(token)} has an unsupported value`, 'Flag values may contain letters, digits and . , : _ / @ { } ^ ~ * + -.')
    }
    if (DENIED_FLAGS.has(name) && !allowed.has(name)) {
      fail('flags.denied', `${name} is not accepted in this tool`, 'Use the named argument instead (for example `message`, `paths`, `mode`), or run the operation outside the tool.')
    }
    if (!allowed.has(name)) {
      fail(
        'flags.unknown',
        `${name} is not allowed for action ${action}`,
        allowed.size === 0 ? `Action ${action} takes no flags.` : `Allowed for ${action}: ${[...allowed].join(', ')}.`,
      )
    }
    out.push(token)
  }
  return out
}

function rejectUnknownFields(args) {
  for (const key of Object.keys(args)) {
    if (!SCOPE_FIELDS.has(key)) {
      fail(
        'arg.unknown',
        `${JSON.stringify(key)} is not a field of this tool`,
        `Use only: ${[...SCOPE_FIELDS].sort().join(', ')}. Committing is git_commit's job.`,
      )
    }
  }
}

function withPaths(argv, paths) {
  if (paths.length > 0) argv.push('--', ...paths)
  return argv
}

function trimmedText(text, label, maximum = 200) {
  const value = String(text).replace(/\s+/g, ' ').trim()
  if (value === '') fail(`${label}.empty`, `${label} must not be empty`, `Pass a non-empty ${label}.`)
  if (value.length > maximum) fail(`${label}.too-long`, `${label} is longer than ${maximum} characters`, `Shorten the ${label}.`)
  if (/[\r\n\0]/.test(value)) fail(`${label}.newline`, `${label} must be a single line`, `Remove line breaks from ${label}.`)
  return value
}

/**
 * 动作表。`kind` 可以是字符串，也可以是 `(args) => 'read' | 'write'`（少数动作看参数定性质，
 * 例如 `tag` 不带 name 时只是列标签）。
 */
const ACTIONS = {
  status: {
    kind: 'read',
    summary: 'working tree state (short format, includes branch and untracked files)',
    build(args) {
      const flags = checkFlags(args, 'status')
      const argv = ['status']
      const machine = flags.some((flag) => flag === '--porcelain' || flag === '--long' || flag.startsWith('--porcelain='))
      if (!machine) argv.push('--short', '--branch')
      if (!flags.some((flag) => ['-uall', '-uno', '-unormal'].includes(flag))) argv.push('-uall')
      argv.push(...flags)
      return withPaths(argv, checkPathspecs(list(args, 'paths')))
    },
  },
  diff: {
    kind: 'read',
    summary: 'diff of the working tree (or of the index with staged: true)',
    build(args) {
      const argv = ['diff', '--no-color']
      const flags = checkFlags(args, 'diff')
      if (boolean(args, 'staged') && !flags.some((flag) => flag === '--cached' || flag === '--staged')) argv.push('--cached')
      const ref = value(args, 'ref')
      if (ref !== undefined) argv.push(checkRef(ref))
      const context = integer(args, 'context', 0, 100)
      if (context !== undefined && !flags.some((flag) => flag === '--unified' || flag === '-U')) argv.push(`--unified=${context}`)
      if (boolean(args, 'stat') && !flags.includes('--stat')) argv.push('--stat')
      if (boolean(args, 'nameOnly') && !flags.includes('--name-only')) argv.push('--name-only')
      argv.push(...flags)
      return withPaths(argv, checkPathspecs(list(args, 'paths')))
    },
  },
  log: {
    kind: 'read',
    summary: 'commit history (limit defaults to 20)',
    build(args) {
      const argv = ['log', '--no-color']
      const flags = checkFlags(args, 'log')
      const limit = integer(args, 'limit', 1, 1000) ?? 20
      if (!flags.some((flag) => flag === '-n' || flag === '--max-count')) argv.push(`--max-count=${limit}`)
      const ref = value(args, 'ref')
      if (ref !== undefined) argv.push(checkRef(ref))
      const since = value(args, 'since')
      if (since !== undefined) argv.push(`--since=${trimmedText(since, 'since')}`)
      const author = value(args, 'author')
      if (author !== undefined) argv.push(`--author=${trimmedText(author, 'author')}`)
      const grep = value(args, 'grep')
      if (grep !== undefined) argv.push(`--grep=${trimmedText(grep, 'grep')}`)
      argv.push(...flags)
      return withPaths(argv, checkPathspecs(list(args, 'paths')))
    },
  },
  show: {
    kind: 'read',
    summary: 'one commit, tag or tree object (defaults to HEAD)',
    build(args) {
      const argv = ['show', '--no-color']
      const flags = checkFlags(args, 'show')
      const ref = value(args, 'ref')
      argv.push(ref === undefined ? 'HEAD' : checkRef(ref))
      if (boolean(args, 'stat') && !flags.includes('--stat')) argv.push('--stat')
      if (boolean(args, 'nameOnly') && !flags.includes('--name-only')) argv.push('--name-only')
      argv.push(...flags)
      return withPaths(argv, checkPathspecs(list(args, 'paths')))
    },
  },
  blame: {
    kind: 'read',
    summary: 'line-by-line authorship of one file',
    build(args) {
      const argv = ['blame', '--no-color']
      const flags = checkFlags(args, 'blame')
      const paths = checkPathspecs(list(args, 'paths'))
      if (paths.length === 0) fail('paths.required', 'blame needs the file to annotate', 'Pass `paths: ["<file>"]`.')
      if (paths.length > 1) fail('paths.too-many', 'blame annotates exactly one file', 'Pass a single path.')
      const ref = value(args, 'ref')
      if (ref !== undefined) argv.push(checkRef(ref))
      argv.push(...flags)
      return withPaths(argv, paths)
    },
  },
  branch: {
    kind: 'read',
    summary: 'list local branches with their upstream and last commit',
    build(args) {
      const argv = ['branch', '-vv']
      const flags = checkFlags(args, 'branch')
      if (boolean(args, 'all') && !flags.some((flag) => flag === '-a' || flag === '--all')) argv.push('-a')
      argv.push(...flags)
      return argv
    },
  },
  rev_parse: {
    kind: 'read',
    summary: 'resolve a revision to a hash (or query repository paths)',
    build(args) {
      const argv = ['rev-parse']
      const flags = checkFlags(args, 'rev_parse')
      const ref = value(args, 'ref')
      if (ref !== undefined) argv.push(checkRef(ref))
      argv.push(...flags)
      if (argv.length === 1) fail('ref.required', 'rev_parse needs a revision or at least one flag', 'Pass `ref: "HEAD"` or a flag such as `--show-toplevel`.')
      return argv
    },
  },
  ls_files: {
    kind: 'read',
    summary: 'index and working-tree file listing',
    build(args) {
      const argv = ['ls-files']
      const flags = checkFlags(args, 'ls_files')
      argv.push(...flags)
      if (argv.length === 1) argv.push('--cached')
      return withPaths(argv, checkPathspecs(list(args, 'paths')))
    },
  },
  stash_list: {
    kind: 'read',
    summary: 'stash entries',
    build(args) {
      const argv = ['stash', 'list']
      argv.push(...checkFlags(args, 'stash_list'))
      return argv
    },
  },
  remote: {
    kind: 'read',
    summary: 'configured remotes and their URLs',
    build(args) {
      const argv = ['remote', '-v']
      const flags = checkFlags(args, 'remote')
      argv.push(...flags.filter((flag) => flag !== '-v'))
      return argv
    },
  },
  config_get: {
    kind: 'read',
    summary: 'read one git config value (or list the config with flags: ["--list"])',
    build(args) {
      const argv = ['config']
      const flags = checkFlags(args, 'config_get')
      const key = value(args, 'key')
      argv.push(...flags)
      if (key !== undefined) {
        if (!/^[A-Za-z0-9][A-Za-z0-9.-]*(\.[A-Za-z0-9][A-Za-z0-9-]*)*$/.test(key)) {
          fail('key.format', `${JSON.stringify(key)} is not a git config key`, 'Use section.key form, e.g. "user.name" or "commit.gpgsign".')
        }
        if (flags.length === 0) argv.push('--get')
        argv.push(key)
      } else if (!flags.some((flag) => ['--list', '-l', '--get-regexp', '--get-all'].includes(flag))) {
        argv.push('--list')
      }
      return argv
    },
  },
  version: {
    kind: 'read',
    summary: 'git version',
    build(args) {
      checkFlags(args, 'version')
      return ['--version']
    },
  },
  add: {
    kind: 'write',
    summary: 'stage paths, or all/update',
    build(args) {
      const argv = ['add']
      const flags = checkFlags(args, 'add')
      const all = boolean(args, 'all')
      const update = boolean(args, 'update')
      if (all && !flags.some((flag) => flag === '-A' || flag === '--all')) argv.push('-A')
      if (update && !flags.some((flag) => flag === '-u' || flag === '--update')) argv.push('-u')
      argv.push(...flags)
      const paths = checkPathspecs(list(args, 'paths'))
      if (!all && !update && paths.length === 0) {
        fail('paths.required', 'add needs paths, all: true or update: true', 'Nothing was staged: pass `paths`, or `all: true` to stage every change.')
      }
      return withPaths(argv, paths)
    },
  },
  restore: {
    kind: 'write',
    summary: 'restore working-tree files, or unstage with staged: true',
    build(args) {
      const argv = ['restore']
      const flags = checkFlags(args, 'restore')
      if (boolean(args, 'staged') && !flags.some((flag) => flag === '--staged' || flag === '-S')) argv.push('--staged')
      const source = value(args, 'source')
      if (source !== undefined) argv.push(`--source=${checkRef(source, 'source')}`)
      argv.push(...flags)
      const paths = checkPathspecs(list(args, 'paths'))
      if (paths.length === 0) {
        fail('paths.required', 'restore needs paths', 'Pass `paths: ["<file>"]`; restore never rewrites the whole tree implicitly.')
      }
      return withPaths(argv, paths)
    },
  },
  switch: {
    kind: 'write',
    summary: 'switch branches (create: true creates it)',
    build(args) {
      const argv = ['switch']
      const flags = checkFlags(args, 'switch')
      const branch = value(args, 'branch')
      if (branch === undefined) fail('branch.required', 'switch needs a branch', 'Pass `branch: "<name>"`.')
      checkBranchName(branch)
      const create = boolean(args, 'create')
      const startPoint = value(args, 'startPoint')
      if (create && !flags.includes('--orphan')) argv.push('-c')
      argv.push(...flags)
      argv.push(branch)
      if (startPoint !== undefined) {
        if (!create && !flags.includes('--orphan')) {
          fail('startPoint.unexpected', 'startPoint only makes sense with create: true', 'Drop startPoint, or set `create: true`.')
        }
        argv.push(checkRef(startPoint, 'startPoint'))
      }
      return argv
    },
  },
  stash: {
    kind: (args) => (['list', 'show'].includes((value(args, 'mode') ?? 'push')) ? 'read' : 'write'),
    summary: 'stash push/pop/apply/drop/list/show',
    build(args) {
      const mode = value(args, 'mode') ?? 'push'
      if (!['push', 'pop', 'apply', 'drop', 'list', 'show'].includes(mode)) {
        fail('mode.unknown', `${JSON.stringify(mode)} is not a stash mode`, 'Use push | pop | apply | drop | list | show.')
      }
      const argv = ['stash', mode]
      const flags = checkFlags(args, 'stash')
      const message = value(args, 'message')
      if (message !== undefined) {
        if (mode !== 'push') fail('message.unexpected', `message only applies to stash push`, 'Drop the message.')
        argv.push('-m', trimmedText(message, 'message', 120))
      }
      argv.push(...flags)
      const paths = checkPathspecs(list(args, 'paths'))
      if (paths.length > 0) {
        if (mode !== 'push') fail('paths.unexpected', `paths only apply to stash push`, 'Drop the paths.')
        return withPaths(argv, paths)
      }
      return argv
    },
  },
  fetch: {
    kind: 'write',
    summary: 'fetch refs from a remote',
    build(args) {
      const argv = ['fetch']
      const flags = checkFlags(args, 'fetch')
      if (boolean(args, 'all') && !flags.includes('--all')) argv.push('--all')
      if (boolean(args, 'prune') && !flags.includes('--prune')) argv.push('--prune')
      if (boolean(args, 'tags') && !flags.some((flag) => flag === '--tags' || flag === '-t')) argv.push('--tags')
      argv.push(...flags)
      const remote = value(args, 'remote')
      if (remote !== undefined && !flags.includes('--all')) argv.push(trimmedText(remote, 'remote', 200))
      const ref = value(args, 'ref')
      if (ref !== undefined) argv.push(checkRef(ref, 'refspec'))
      return argv
    },
  },
  pull: {
    kind: 'write',
    summary: 'fetch and integrate a remote branch',
    build(args) {
      const argv = ['pull']
      const flags = checkFlags(args, 'pull')
      if (boolean(args, 'rebase') && !flags.some((flag) => flag === '--rebase' || flag === '-r')) argv.push('--rebase')
      argv.push(...flags)
      const remote = value(args, 'remote')
      if (remote !== undefined) argv.push(trimmedText(remote, 'remote', 200))
      const branch = value(args, 'branch')
      if (branch !== undefined) {
        if (remote === undefined) fail('branch.needs-remote', 'branch needs an explicit remote', 'Pass `remote` as well, e.g. remote: "origin", branch: "main".')
        argv.push(checkBranchName(branch))
      }
      return argv
    },
  },
  push: {
    kind: 'write',
    summary: 'push commits to a remote (force: "with-lease" is the safe force)',
    build(args) {
      const argv = ['push']
      const flags = checkFlags(args, 'push')
      if (boolean(args, 'setUpstream') && !flags.some((flag) => flag === '-u' || flag === '--set-upstream')) argv.push('--set-upstream')
      if (boolean(args, 'tags') && !flags.includes('--tags')) argv.push('--tags')
      const force = value(args, 'force') ?? 'none'
      if (!['none', 'with-lease', 'force'].includes(force)) {
        fail('force.unknown', `${JSON.stringify(force)} is not a force mode`, 'Use none | with-lease | force.')
      }
      if (force === 'with-lease' && !flags.includes('--force-with-lease')) argv.push('--force-with-lease')
      if (force === 'force' && !flags.includes('--force')) argv.push('--force')
      argv.push(...flags)
      const remote = value(args, 'remote')
      if (remote !== undefined) argv.push(trimmedText(remote, 'remote', 200))
      const branch = value(args, 'branch')
      if (branch !== undefined) argv.push(checkBranchName(branch))
      return argv
    },
  },
  merge: {
    kind: 'write',
    summary: 'merge a branch (or abort/continue an in-progress merge)',
    build(args) {
      const argv = ['merge']
      const flags = checkFlags(args, 'merge')
      if (boolean(args, 'abort')) return ['merge', '--abort', ...flags]
      if (boolean(args, 'continue')) return ['merge', '--continue', ...flags]
      const ref = value(args, 'ref')
      if (ref === undefined) fail('ref.required', 'merge needs the revision to merge', 'Pass `ref: "<branch>"`, or `abort: true` / `continue: true`.')
      if (boolean(args, 'noFf') && !flags.includes('--no-ff')) argv.push('--no-ff')
      if (!flags.some((flag) => flag === '--no-edit' || flag === '--edit')) argv.push('--no-edit')
      const message = value(args, 'message')
      if (message !== undefined) argv.push('-m', trimmedText(message, 'message'))
      argv.push(...flags)
      argv.push(checkRef(ref))
      return argv
    },
  },
  revert: {
    kind: 'write',
    summary: 'revert commits (abort/continue are implied by flags: ["--abort"])',
    build(args) {
      const argv = ['revert']
      const flags = checkFlags(args, 'revert')
      if (boolean(args, 'noCommit') && !flags.some((flag) => flag === '-n' || flag === '--no-commit')) argv.push('--no-commit')
      if (!flags.some((flag) => flag === '--abort' || flag === '--continue' || flag === '--quit' || flag === '--skip')) {
        if (!flags.includes('--no-edit')) argv.push('--no-edit')
      }
      argv.push(...flags)
      const refs = [...list(args, 'refs'), ...(value(args, 'ref') === undefined ? [] : [value(args, 'ref')])]
      if (refs.length === 0) fail('ref.required', 'revert needs at least one revision', 'Pass `ref` or `refs: [...]`.')
      for (const ref of refs) argv.push(checkRef(ref))
      return argv
    },
  },
  cherry_pick: {
    kind: 'write',
    summary: 'cherry-pick commits',
    build(args) {
      const argv = ['cherry-pick']
      const flags = checkFlags(args, 'cherry_pick')
      if (boolean(args, 'noCommit') && !flags.some((flag) => flag === '-n' || flag === '--no-commit')) argv.push('--no-commit')
      const mainline = integer(args, 'mainline', 1, 64)
      if (mainline !== undefined && !flags.includes('--mainline')) argv.push('--mainline', String(mainline))
      argv.push(...flags)
      const refs = [...list(args, 'refs'), ...(value(args, 'ref') === undefined ? [] : [value(args, 'ref')])]
      if (refs.length === 0) fail('ref.required', 'cherry_pick needs at least one revision', 'Pass `ref` or `refs: [...]`.')
      for (const ref of refs) argv.push(checkRef(ref))
      return argv
    },
  },
  reset: {
    kind: 'write',
    summary: 'move HEAD (mode: soft|mixed|hard; hard needs confirm: true)',
    build(args) {
      const argv = ['reset']
      const flags = checkFlags(args, 'reset')
      const mode = value(args, 'mode') ?? 'mixed'
      if (!['soft', 'mixed', 'hard', 'merge', 'keep'].includes(mode)) {
        fail('mode.unknown', `${JSON.stringify(mode)} is not a reset mode`, 'Use soft | mixed | hard | merge | keep.')
      }
      if (mode === 'hard' && args.confirm !== true) {
        fail(
          'reset.confirm',
          'reset --hard discards uncommitted work and needs confirm: true',
          'Run `git({ action: "status" })` and `git({ action: "diff" })` first, then repeat with `confirm: true` if the loss is intended.',
        )
      }
      argv.push(`--${mode}`)
      argv.push(...flags)
      const ref = value(args, 'ref')
      if (ref === undefined) {
        if (mode === 'hard') fail('ref.required', 'reset --hard needs the target revision', 'Pass `ref: "HEAD"` or a revision.')
        argv.push('HEAD')
      } else {
        argv.push(checkRef(ref))
      }
      return withPaths(argv, checkPathspecs(list(args, 'paths')))
    },
  },
  rm: {
    kind: 'write',
    summary: 'remove files from the working tree and the index',
    build(args) {
      const argv = ['rm']
      const flags = checkFlags(args, 'rm')
      if (boolean(args, 'recursive') && !flags.some((flag) => flag === '-r' || flag === '--recursive')) argv.push('-r')
      if (boolean(args, 'cached') && !flags.includes('--cached')) argv.push('--cached')
      if (boolean(args, 'force') && !flags.some((flag) => flag === '-f' || flag === '--force')) argv.push('-f')
      argv.push(...flags)
      const paths = checkPathspecs(list(args, 'paths'))
      if (paths.length === 0) fail('paths.required', 'rm needs paths', 'Pass `paths: ["<file>"]`.')
      return withPaths(argv, paths)
    },
  },
  mv: {
    kind: 'write',
    summary: 'move or rename a tracked file',
    build(args) {
      const argv = ['mv']
      const flags = checkFlags(args, 'mv')
      const from = value(args, 'from')
      const to = value(args, 'to')
      if (from === undefined || to === undefined) fail('paths.required', 'mv needs from and to', 'Pass `from` and `to`, both repository-relative paths.')
      for (const path of checkPathspecs([from, to])) argv.push(path)
      argv.push(...flags)
      return argv
    },
  },
  tag: {
    kind: (args) => (value(args, 'name') === undefined && !boolean(args, 'delete') ? 'read' : 'write'),
    summary: 'list tags (no name), or create/delete one',
    build(args) {
      const argv = ['tag']
      const flags = checkFlags(args, 'tag')
      const name = value(args, 'name')
      const remove = boolean(args, 'delete')
      if (name === undefined) {
        if (remove) fail('name.required', 'delete needs the tag name', 'Pass `name: "<tag>"` with `delete: true`.')
        return ['tag', '--list', ...flags]
      }
      checkBranchName(name)
      if (remove) return ['tag', '--delete', name, ...flags]
      const message = value(args, 'message')
      if (message !== undefined && !flags.includes('-s') && !flags.includes('--sign')) argv.push('--annotate')
      if (boolean(args, 'force') && !flags.some((flag) => flag === '-f' || flag === '--force')) argv.push('--force')
      argv.push(...flags)
      argv.push(name)
      const ref = value(args, 'ref')
      if (ref !== undefined) argv.push(checkRef(ref))
      if (message !== undefined) argv.push('-m', trimmedText(message, 'message'))
      return argv
    },
  },
  clean: {
    kind: 'write',
    summary: 'delete untracked files (dry-run unless confirm: true)',
    build(args) {
      const argv = ['clean']
      const flags = checkFlags(args, 'clean')
      const dryRun = args.dryRun === undefined ? true : boolean(args, 'dryRun')
      if (dryRun) {
        argv.push('--dry-run')
        if (!flags.some((flag) => flag === '-d' || flag === '--no-directories')) argv.push('-d')
      } else {
        if (args.confirm !== true) {
          fail(
            'clean.confirm',
            'deleting untracked files needs confirm: true',
            'Run it once with the default `dry_run: true` to see the list, then repeat with `confirm: true, dry_run: false`.',
          )
        }
        argv.push('--force')
      }
      argv.push(...flags)
      return argv
    },
  },
  clone: {
    kind: 'write',
    summary: 'clone a repository into a new directory',
    build(args) {
      const argv = ['clone']
      const flags = checkFlags(args, 'clone')
      const url = value(args, 'url')
      if (url === undefined) {
        fail('url.required', 'clone needs the repository to clone', 'Pass `url`, e.g. "https://github.com/owner/repo.git" or "git@github.com:owner/repo.git".')
      }
      checkRemoteUrl(url)
      const depth = integer(args, 'depth', 1, 1_000_000)
      if (depth !== undefined && !flags.includes('--depth')) argv.push(`--depth=${depth}`)
      const branch = value(args, 'branch')
      if (branch !== undefined && !flags.some((flag) => flag === '--branch' || flag === '-b')) {
        argv.push('--branch', checkBranchName(branch))
      }
      argv.push(...flags)
      argv.push(url)
      const dir = value(args, 'dir')
      if (dir !== undefined) argv.push(checkTargetDirectory(dir))
      return argv
    },
  },
  init: {
    kind: 'write',
    summary: 'create a repository in the session directory',
    build(args) {
      const argv = ['init']
      const flags = checkFlags(args, 'init')
      if (boolean(args, 'bare') && !flags.includes('--bare')) argv.push('--bare')
      argv.push(...flags)
      return argv
    },
  },
}

/** 全部动作名。 */
export function actionNames() {
  return Object.keys(ACTIONS).sort()
}

/**
 * 动作名 → `'read'` / `'write'` / `'mixed'`（`mixed` 表示性质由参数决定，如 tag / stash）。
 * 工具描述与调度提示都读这张表。
 */
export function actionKinds() {
  const map = new Map()
  for (const [action, spec] of Object.entries(ACTIONS)) {
    map.set(action, typeof spec.kind === 'function' ? 'mixed' : spec.kind)
  }
  return map
}

/** 某个动作在本次调用下是只读还是写（`tag` / `stash` 看参数）。 */
export function planKind(rawArgs) {
  const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
  const spec = ACTIONS[action]
  if (spec === undefined) return 'write'
  return typeof spec.kind === 'function' ? spec.kind(args) : spec.kind
}

/** 动作的一句话说明，拼进工具描述与调用卡片。 */
export function actionSummaries() {
  return Object.entries(ACTIONS)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => `${name}: ${spec.summary}`)
}

/**
 * 把一次 `git` 工具调用编译成 argv。
 *
 * @param rawArgs - 模型给的参数对象。
 * @param options - `{ defaultDir }`：会话工作目录，作为相对 `cwd` 的解析基准。
 * @returns `{ ok: false, errors }` 或
 *          `{ ok: true, action, argv, cwd, kind, display, summary }`。
 */
export function buildPlan(rawArgs, options = {}) {
  const args = rawArgs !== null && typeof rawArgs === 'object' ? rawArgs : {}
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : ''
  if (action === '') {
    return { ok: false, errors: [bad('action.missing', 'action is required', `Pass one of: ${actionNames().join(', ')}.`)] }
  }
  if (action === 'commit') {
    return {
      ok: false,
      errors: [bad('action.commit', 'this tool does not commit', 'Use the `git_commit` tool: it composes the message from type/scope/subject/body and validates it before anything is written.')],
    }
  }
  const spec = ACTIONS[action]
  if (spec === undefined) {
    return {
      ok: false,
      errors: [bad('action.unknown', `${JSON.stringify(action)} is not a supported action`, `Supported actions: ${actionNames().join(', ')}. Committing is git_commit's job.`)],
    }
  }
  let argv
  try {
    rejectUnknownFields(args)
    argv = spec.build(args)
  } catch (error) {
    if (error instanceof ValidationError) return { ok: false, errors: error.errors }
    throw error
  }
  const base = typeof options.defaultDir === 'string' && options.defaultDir !== '' ? options.defaultDir : process.cwd()
  const rawCwd = value(args, 'cwd')
  const kind = typeof spec.kind === 'function' ? spec.kind(args) : spec.kind
  return {
    ok: true,
    action,
    argv,
    cwd: rawCwd === undefined ? base : rawCwd,
    kind,
    display: `git ${argv.join(' ')}`,
    summary: spec.summary,
  }
}

/** 只读动作集合（供调度器判断能否并行）。 */
export const READ_ACTIONS = new Set(Object.entries(ACTIONS).filter(([, spec]) => spec.kind === 'read').map(([name]) => name))
