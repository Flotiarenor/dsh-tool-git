// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * conventions.mjs —— 提交规范的事实来源：**内置默认值** + **仓库内覆盖文件**。
 *
 * 为什么要文件覆盖：规范是项目的属性，不是插件的属性。同一个 profile 下既有中文主题的仓库，
 * 也有英文主题、强制 scope、甚至自带 commitlint 的仓库；把规则写死在插件里，模型只能靠提示词
 * 记住"这个仓库不一样"。所以规则按下面的优先级合并，最高优先级的来源在提示词里被点名：
 *
 *   内置默认值  <  profile 行 config（本插件的全局默认）  <  仓库内规范文件
 *
 * 仓库内规范文件的格式（Markdown，键值行会被解析成规则，其余行原样进提示词）：
 *
 *   # 本仓库提交规范
 *   types: feat, fix, docs, chore          # 限定 type 取值
 *   scopes: core, ui, api                  # 非空则 scope 必须取自这里
 *   requireScope: true
 *   subjectMaxColumns: 60                  # 显示宽度（CJK 记 2 列）
 *   bodyMaxColumns: 100
 *   language: zh                           # any | zh | en
 *   subjectLowerCase: false
 *   requireBody: true
 *   allowEmoji: false
 *   banned: 补丁, 临时, hack                 # 追加的口语/填充词
 *
 *   其余自由文本（例如"正文必须写清影响范围"）原样进入提示词段。
 *   - 只认已知键：拼错的键名不会被静默吃掉，而是留在自由文本里，模型仍能看到。
 *   - 最近的文件胜出（会话目录优先于仓库根），不做跨文件合并：规则只有一份，避免"到底哪条生效"。
 *
 * 本模块**只用 node: 内置模块**，且读文件是同步的：提示词段（systemPrompt.section）的 text 回调
 * 是同步签名，所以同步读 + mtime/size 缓存是唯一不需要把装配变成异步的做法。文件都很小（上限 64 KB）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

/** Conventional Commits 的默认 type 集合。 */
export const DEFAULT_TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]

/** type 的中文释义，只用于提示词里解释"该选哪个"。 */
export const TYPE_HINTS = {
  feat: '新功能',
  fix: '修缺陷',
  docs: '只改文档/注释',
  style: '只改格式，不改语义',
  refactor: '重构，行为不变',
  perf: '性能优化',
  test: '只改测试',
  build: '构建系统或依赖',
  ci: 'CI 配置',
  chore: '杂务，不属于以上任何一类',
  revert: '回滚既有提交',
}

/**
 * 主题行里的口语/填充词（中文，子串匹配）。
 * 这一档只用于**主题行**：`就是` / `然后` / `而且` 在正文里可能是正常表达，在主题行里一定是废话。
 */
export const SUBJECT_FILLER_ZH = [
  '其实就是',
  '其实就是说',
  '其实',
  '反正',
  '貌似',
  '好像',
  '差不多',
  '大概',
  '稍微',
  '一下下',
  '搞一下',
  '搞了',
  '搞个',
  '弄一下',
  '弄了',
  '弄个',
  '整一下',
  '整了',
  '先这样',
  '试试看',
  '试试',
  '随手',
  '顺手',
  '顺便',
  '巴拉巴拉',
  '之类的',
  '什么的',
  '就是',
  '然后',
  '而且',
  '所以',
  '另外',
  '对了',
  '还有',
  '感觉',
  '我觉得',
  '我感觉',
  '我记得',
  '咱',
  '啥',
  '咋',
  '嗯',
  '呃',
  '哎',
  '哈哈',
  '嘿嘿',
  '呗',
  '啦',
  '咯',
  '呀',
  '哦',
  '嘛',
]

/** 主题行与正文都禁止的填充词（中文，子串匹配）。 */
export const BODY_FILLER_ZH = [
  '其实就是',
  '反正',
  '貌似',
  '差不多',
  '巴拉巴拉',
  '之类的',
  '什么的',
  '哈哈',
  '嘿嘿',
  '试试看',
  '先这样',
  '我觉得',
  '我感觉',
  '别忘了',
  '咱',
  '啥',
  '咋',
  '嗯',
  '呃',
]

/** 英文口语词，按词边界匹配（大小写不敏感）。 */
export const FILLER_EN = [
  'just',
  'kinda',
  'sorta',
  'stuff',
  'things',
  'whatever',
  'maybe',
  'oops',
  'hopefully',
  'basically',
  'actually',
  'literally',
  'obviously',
  'gonna',
  'wanna',
  'blah',
  'lorem',
  'foo',
  'asdf',
  'a bit',
  'sort of',
  'kind of',
  'pretty much',
  'and so on',
  'etc',
]

/** 主题行禁止出现的标点/噪音。 */
export const SUBJECT_NOISE = ['!!!', '！！！', '？？？', '……', '。。。', '～～', '···', '...']

/**
 * 纯占位主题：写这些等于没写。只在**整体等于**其中一项时判失败，不做子串匹配
 * （否则"修复测试超时"里的"测试"会被误判）。
 */
export const PLACEHOLDER_SUBJECTS = [
  'update',
  'updates',
  'updated',
  'fix',
  'fixes',
  'fixed',
  'wip',
  'tmp',
  'temp',
  'test',
  'change',
  'changes',
  'misc',
  'stuff',
  'things',
  'minor',
  'patch',
  'improve',
  'improvements',
  'refactor',
  'cleanup',
  'tweak',
  'tweaks',
  'various',
  '修改',
  '更新',
  '提交',
  '改动',
  '调整',
  '优化',
  '修复',
  '重构',
  '代码',
  '一些修改',
  '若干修改',
  '各种修改',
  '更新代码',
  '修改代码',
  '代码更新',
  '日常',
  '例行',
  '小改动',
  '杂项',
]

/** 内置默认规则。 */
export const DEFAULT_CONVENTIONS = Object.freeze({
  types: Object.freeze([...DEFAULT_TYPES]),
  scopes: Object.freeze([]),
  requireScope: false,
  subjectMaxColumns: 72,
  subjectSoftColumns: 0,
  bodyMaxColumns: 100,
  language: 'any',
  subjectLowerCase: false,
  requireBody: false,
  allowEmoji: false,
  firstPerson: false,
  banned: Object.freeze([]),
})

/** 仓库内规范文件的查找顺序（相对被搜索目录）。 */
export const CONVENTIONS_FILES = [
  '.dsh/commit-conventions.md',
  '.dsh/git-conventions.md',
  '.dsh/commit.md',
  '.commit-conventions.md',
  '.git-commit-conventions.md',
  'docs/commit-conventions.md',
]

/** 只用于"告知"的 commitlint 配置文件名：命中就在提示词里提醒 hooks 会再校验一次。 */
export const COMMITLINT_FILES = [
  'commitlint.config.mjs',
  'commitlint.config.cjs',
  'commitlint.config.js',
  'commitlint.config.ts',
  'commitlint.config.json',
  '.commitlintrc',
  '.commitlintrc.json',
  '.commitlintrc.yml',
  '.commitlintrc.yaml',
  '.commitlintrc.js',
  '.commitlintrc.cjs',
  '.commitlintrc.mjs',
]

const MAX_FILE_BYTES = 64 * 1024
const MAX_PROSE_BYTES = 4096
const MAX_WALK_DEPTH = 64

/** 键名归一：小写、去掉 `_`/`-`/空格，于是 `require_scope` / `Require-Scope` 都能命中。 */
function normalizeKey(key) {
  return key.toLowerCase().replace(/[\s_-]+/g, '')
}

const KEY_TABLE = new Map(
  Object.entries({
    type: 'types',
    types: 'types',
    allowedtype: 'types',
    allowedtypes: 'types',
    scope: 'scopes',
    scopes: 'scopes',
    allowedscope: 'scopes',
    allowedscopes: 'scopes',
    requirescope: 'requireScope',
    subjectmaxcolumns: 'subjectMaxColumns',
    subjectwidth: 'subjectMaxColumns',
    subjectmaxlength: 'subjectMaxColumns',
    subjectmax: 'subjectMaxColumns',
    subjectsoftcolumns: 'subjectSoftColumns',
    subjectsoftwidth: 'subjectSoftColumns',
    subjectsuggestedcolumns: 'subjectSoftColumns',
    subjecttargetcolumns: 'subjectSoftColumns',
    bodymaxcolumns: 'bodyMaxColumns',
    bodywidth: 'bodyMaxColumns',
    bodymaxlength: 'bodyMaxColumns',
    language: 'language',
    lang: 'language',
    subjectlowercase: 'subjectLowerCase',
    requirebody: 'requireBody',
    allowemoji: 'allowEmoji',
    emoji: 'allowEmoji',
    firstperson: 'firstPerson',
    nofirstperson: 'firstPerson',
    banfirstperson: 'firstPerson',
    firstpersonnarration: 'firstPerson',
    banned: 'banned',
    bannedwords: 'banned',
    forbidden: 'banned',
    forbiddenwords: 'banned',
    filler: 'banned',
  }),
)

/** 按 `,`/`，`/`、`/`;`/空白 切列表。 */
function splitList(value) {
  return String(value)
    .split(/[,，、;；\s]+/)
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

function parseBoolean(value, label) {
  const token = String(value).trim().toLowerCase()
  if (['true', 'yes', 'on', '1', '是', '开'].includes(token)) return true
  if (['false', 'no', 'off', '0', '否', '关'].includes(token)) return false
  throw new Error(`${label} must be a boolean (true/false), got ${JSON.stringify(value)}`)
}

function parsePositiveInt(value, label, minimum, maximum) {
  const number = Number.parseInt(String(value).trim(), 10)
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new Error(`${label} must be an integer in [${minimum}, ${maximum}], got ${JSON.stringify(value)}`)
  }
  return number
}

/**
 * 解析一份规范文件的文本。
 * @param text - 文件内容。
 * @param source - 文件路径（只用于错误信息）。
 * @returns `{ rules, prose }`：`rules` 是识别出的规则（可能部分字段），`prose` 是其余自由文本。
 * @throws {Error} 已知键的值非法时抛错——写错的规则应当立刻可见，而不是静默退回默认值。
 */
export function parseConventionsText(text, source = '<memory>') {
  const rules = {}
  const prose = []
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n')
  for (const line of lines) {
    const match = /^\s*([A-Za-z][A-Za-z0-9_ -]*)\s*[:：]\s*(.*)$/.exec(line)
    const key = match === null ? null : KEY_TABLE.get(normalizeKey(match[1]))
    if (key === null) {
      prose.push(line)
      continue
    }
    const raw = match[2].trim()
    try {
      switch (key) {
        case 'types':
          rules.types = splitList(raw).map((item) => item.toLowerCase())
          break
        case 'scopes':
          rules.scopes = splitList(raw)
          break
        case 'requireScope':
        case 'subjectLowerCase':
        case 'requireBody':
        case 'firstPerson':
          rules[key] = parseBoolean(raw, key)
          break
        case 'allowEmoji':
          rules.allowEmoji = parseBoolean(raw, key)
          break
        case 'subjectMaxColumns':
          rules.subjectMaxColumns = parsePositiveInt(raw, key, 20, 200)
          break
        case 'subjectSoftColumns':
          // 0 表示不设"建议上限"（只保留硬上限）。
          rules.subjectSoftColumns = raw.trim() === '0' ? 0 : parsePositiveInt(raw, key, 20, 200)
          break
        case 'bodyMaxColumns':
          // 0 表示不限制正文行宽（有的仓库习惯一个自然段一行、并在正文里贴命令输出）。
          rules.bodyMaxColumns = raw.trim() === '0' ? 0 : parsePositiveInt(raw, key, 40, 400)
          break
        case 'language': {
          const value = raw.toLowerCase()
          if (!['any', 'zh', 'en'].includes(value)) {
            throw new Error(`language must be any | zh | en, got ${JSON.stringify(raw)}`)
          }
          rules.language = value
          break
        }
        case 'banned':
          rules.banned = splitList(raw)
          break
        default:
          prose.push(line)
      }
    } catch (error) {
      throw new Error(`${source}: ${error.message}`)
    }
  }
  return { rules, prose: prose.join('\n').trim() }
}

/** 往上找 Git 仓库根（含 `.git` 的目录）；找不到就返回起点。 */
export function findRepoRoot(startDir) {
  let current = resolve(startDir)
  for (let depth = 0; depth < MAX_WALK_DEPTH; depth++) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return resolve(startDir)
}

/** 小缓存：仓库根与解析过的文件都按"路径 + mtime + size"缓存，装配每步都会调用这里。 */
const rootCache = new Map()
const fileCache = new Map()
const CACHE_LIMIT = 256

function cachePut(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, value)
  return value
}

function cachedRepoRoot(dir) {
  const hit = rootCache.get(dir)
  if (hit !== undefined) return hit
  return cachePut(rootCache, dir, findRepoRoot(dir))
}

/** 读一个候选文件并解析；不存在返回 null。 */
function readCandidate(path) {
  let info
  try {
    info = statSync(path)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  const stamp = `${info.mtimeMs}:${info.size}`
  const hit = fileCache.get(path)
  if (hit !== undefined && hit.stamp === stamp) return hit.value
  const text = readFileSync(path, 'utf8').slice(0, MAX_FILE_BYTES)
  const value = { path, text, ...parseConventionsText(text, path) }
  fileCache.set(path, { stamp, value })
  return value
}

/** 在若干目录里按名字顺序找第一个存在的文件。 */
function firstExisting(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const hit = readCandidate(join(dir, name))
      if (hit !== null) return hit
    }
  }
  return null
}

function firstExistingPath(dirs, names) {
  for (const dir of dirs) {
    for (const name of names) {
      const path = join(dir, name)
      if (existsSync(path)) return path
    }
  }
  return null
}

/** 合并三层规则并做最终的合法性检查。 */
function mergeRules(base, overlay, label) {
  const merged = { ...base }
  if (overlay === undefined || overlay === null) return merged
  for (const [key, value] of Object.entries(overlay)) {
    if (value === undefined) continue
    merged[key] = value
  }
  if (!Array.isArray(merged.types) || merged.types.length === 0) {
    throw new Error(`${label}: types must not be empty`)
  }
  if (merged.types.some((type) => typeof type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(type))) {
    throw new Error(`${label}: every type must match /^[a-z][a-z0-9-]*$/`)
  }
  if (merged.scopes.some((scope) => typeof scope !== 'string' || scope.trim() === '')) {
    throw new Error(`${label}: scopes must be non-empty strings`)
  }
  if (!['any', 'zh', 'en'].includes(merged.language)) {
    throw new Error(`${label}: language must be any | zh | en`)
  }
  if (merged.subjectSoftColumns !== undefined && merged.subjectSoftColumns !== 0) {
    if (!Number.isInteger(merged.subjectSoftColumns) || merged.subjectSoftColumns < 20 || merged.subjectSoftColumns > 200) {
      throw new Error(`${label}: subjectSoftColumns must be 0 (off) or an integer in [20, 200]`)
    }
    if (merged.subjectSoftColumns >= merged.subjectMaxColumns) {
      throw new Error(`${label}: subjectSoftColumns (${merged.subjectSoftColumns}) must be smaller than subjectMaxColumns (${merged.subjectMaxColumns}), otherwise the suggestion can never fire`)
    }
  }
  if (merged.bodyMaxColumns !== 0 && (!Number.isInteger(merged.bodyMaxColumns) || merged.bodyMaxColumns < 40 || merged.bodyMaxColumns > 400)) {
    throw new Error(`${label}: bodyMaxColumns must be 0 (no limit) or an integer in [40, 400]`)
  }
  if (merged.firstPerson !== undefined && typeof merged.firstPerson !== 'boolean') {
    throw new Error(`${label}: firstPerson must be a boolean`)
  }
  return merged
}

/**
 * 解析出"这一次会话该用哪套规范"。
 *
 * @param startDir - 会话工作目录；不存在或非字符串时退回 `process.cwd()`。
 * @param options - `{ rules, files, commitlintFiles, maxProseBytes, discover }`：
 *   `rules` 是 profile 行 config 里的全局默认，`discover: false` 表示不读仓库文件（只用内置 + config）。
 * @returns `{ rules, prose, source, commitlint, repoRoot, cwd }`。
 * @throws {Error} 规范文件里的已知键取值非法时抛错（拼错的键名不会抛错，会留在 prose 里）。
 */
export function loadConventions(startDir, options = {}) {
  const cwd = typeof startDir === 'string' && startDir.trim() !== '' ? resolve(startDir) : process.cwd()
  const files = Array.isArray(options.files) && options.files.length > 0 ? options.files : CONVENTIONS_FILES
  const commitlintFiles = Array.isArray(options.commitlintFiles) && options.commitlintFiles.length > 0
    ? options.commitlintFiles
    : COMMITLINT_FILES
  const discover = options.discover !== false
  const maxProseBytes = Number.isInteger(options.maxProseBytes) && options.maxProseBytes > 0
    ? options.maxProseBytes
    : MAX_PROSE_BYTES

  const repoRoot = discover ? cachedRepoRoot(cwd) : cwd
  // 会话目录优先于仓库根：子目录可以用一份更严的规则覆盖整个仓库。
  const dirs = repoRoot === cwd ? [cwd] : [cwd, repoRoot]

  const found = discover ? firstExisting(dirs, files) : null
  const rules = mergeRules(
    mergeRules(DEFAULT_CONVENTIONS, options.rules, 'plugin config'),
    found === null ? undefined : found.rules,
    found === null ? '' : found.path,
  )

  const prose = found === null ? '' : found.prose.slice(0, maxProseBytes)

  return {
    rules,
    prose,
    source: found === null ? null : found.path,
    commitlint: discover ? firstExistingPath(dirs, commitlintFiles) : null,
    repoRoot,
    cwd,
  }
}

/** 提示词里不允许出现 `{{`（会被当作提示词变量引用），仓库文件是外部输入，必须消毒。 */
export function sanitizePromptText(text) {
  return String(text).replace(/\{\{/g, '{ {')
}

function exampleLines(rules) {
  if (rules.language === 'zh') {
    return [
      '  feat(parser): 支持 YAML 锚点复用',
      '  fix(ui): 修复长路径下的按钮换行',
      '  refactor(core)!: 移除已废弃的 sync 接口',
    ]
  }
  return [
    '  feat(parser): support YAML anchor reuse',
    '  fix(ui): stop the button wrapping on long paths',
    '  refactor(core)!: drop the deprecated sync API',
  ]
}

/**
 * 把规则渲染成**注入系统提示词的那段约束**。
 *
 * 只写"会被强制校验的东西"和"该选什么"：格式、字段规则、实际生效的数值、type 释义、示例，
 * 以及仓库内文件的自由文本（原样附上，标注来源）。
 *
 * @param resolved - `loadConventions` 的返回值。
 */
export function renderConventions(resolved) {
  const { rules, prose, source, commitlint } = resolved
  const lines = []
  lines.push('Commit messages are composed and validated by the `git_commit` tool; the rules below are the ones it enforces (a violation is refused, not rewritten).')
  lines.push('')
  lines.push('format:')
  lines.push('  <type>(<scope>): <subject>')
  lines.push('')
  lines.push('  <body>')
  lines.push('')
  lines.push('  <footers>')
  lines.push('')
  const typeText = rules.types
    .map((type) => (TYPE_HINTS[type] === undefined ? type : `${type} (${TYPE_HINTS[type]})`))
    .join(', ')
  lines.push(`types: ${typeText}`)
  if (rules.scopes.length > 0) {
    lines.push(`scopes: ${rules.scopes.join(', ')}${rules.requireScope ? ' (required)' : ''}`)
  } else if (rules.requireScope) {
    lines.push('scope: required')
  } else {
    lines.push('scope: optional, lowercase, no spaces')
  }
  const soft = rules.subjectSoftColumns === undefined ? 0 : rules.subjectSoftColumns
  const subjectLimit = soft > 0
    ? `at most ${rules.subjectMaxColumns} display columns (a CJK character counts 2), and this project asks for <= ${soft} — anything longer is reported as a warning`
    : `at most ${rules.subjectMaxColumns} display columns (a CJK character counts 2)`
  lines.push(
    `subject: required, ${subjectLimit}, `
    + 'no trailing period/!/~, no colloquial filler, no emoji, and not a bare placeholder such as "update" or "修改"',
  )
  const bodyLimit = rules.bodyMaxColumns > 0
    ? `optional, wrapped at ${rules.bodyMaxColumns} columns, blank line between paragraphs, "- " for bullets`
    : 'optional, no line-width limit in this project, blank line between paragraphs, "- " for bullets'
  lines.push(`body: ${bodyLimit}${rules.requireBody ? ', and required for this project' : ''}`)
  lines.push('breaking: a breaking change sets `breaking` (the tool adds `!` and the `BREAKING CHANGE:` trailer)')
  lines.push('footers: git trailers, e.g. `Refs: #123`, `Closes #42`, `Co-authored-by: Name <mail>`')
  if (rules.firstPerson === true) {
    lines.push('person: write about the change, not about who made it — a first-person "我" is refused in the subject and reported in the body')
  }
  lines.push('')
  lines.push('examples:')
  lines.push(...exampleLines(rules))
  if (!rules.allowEmoji) lines.push('')
  if (rules.banned.length > 0) {
    lines.push(`this project additionally rejects: ${rules.banned.join(', ')}`)
  }
  if (languageText(rules) !== '') lines.push(languageText(rules))
  if (prose !== '') {
    lines.push('')
    lines.push(`Project rules${source === null ? '' : ` from ${source}`} (these take precedence over the defaults above):`)
    lines.push(sanitizePromptText(prose))
  }
  if (commitlint !== null) {
    lines.push('')
    lines.push(`This repository also carries a commitlint config (${commitlint}); hooks always run, so a message that passes here but fails the hook is reported back verbatim.`)
  }
  return lines.join('\n')
}

function languageText(rules) {
  if (rules.language === 'zh') return 'language: the subject must contain Chinese text (English-only subjects are refused)'
  if (rules.language === 'en') return 'language: the subject must be ASCII English, imperative mood, lowercase after the colon'
  return ''
}
