// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * selftest.mjs —— 本插件的自测：纯函数、argv 拼装、shell 识别、以及**真实 git 仓库**上的端到端。
 *
 *   node tools/selftest.mjs
 *
 * 端到端部分会在系统临时目录里建一个仓库、写文件、真的提交一次，并核对四个性质：
 *   1. 合规的字段能提交成功，且落库信息逐字等于插件拼装的那一条；
 *   2. 不合规的字段**一条也不会落库**（提交数不变）；
 *   3. dry_run 不产生提交；
 *   4. 没有暂存内容时拒绝提交，而不是提交一个空提交。
 * 没有 git 可用时这一节会跳过（其余断言照跑），因此 CI 里没有 git 也不会假绿。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_TYPES,
  loadConventions,
  parseConventionsText,
  renderConventions,
  sanitizePromptText,
} from '../lib/conventions.mjs'
import { composeMessage, displayWidth, lintCommit, parseMessage } from '../lib/message.mjs'
import { classifyGitArgs, detectShellGitBlock } from '../lib/shellgit.mjs'
import { actionKinds, actionNames, buildPlan } from '../lib/commands.mjs'
import { createExecutor } from '../lib/exec.mjs'
import { apply, internals, readSettings } from '../lib/git.mjs'

let passed = 0
const failures = []

function check(label, condition, detail = '') {
  if (condition) {
    passed++
    return
  }
  failures.push(`${label}${detail === '' ? '' : ` — ${detail}`}`)
}

function equal(label, actual, expected) {
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

function includes(label, haystack, needle) {
  check(label, String(haystack).includes(needle), `${JSON.stringify(needle)} not found`)
}

function codes(result) {
  return result.errors.map((item) => item.code)
}

function hasCode(label, result, code) {
  check(label, codes(result).includes(code), `codes: ${codes(result).join(', ') || '(none)'}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. 显示宽度与拼装
// ─────────────────────────────────────────────────────────────────────────────
equal('width ascii', displayWidth('abc'), 3)
equal('width cjk counts 2', displayWidth('中文'), 4)
equal('width mixed', displayWidth('a中b'), 4)
equal('width emoji counts 2', displayWidth('👍'), 2)

{
  const message = composeMessage({ type: 'feat', scope: 'parser', subject: '支持 YAML 锚点复用' })
  equal('compose head', message, 'feat(parser): 支持 YAML 锚点复用\n')
}
{
  const message = composeMessage({
    type: 'refactor',
    scope: 'core',
    subject: '移除已废弃的 sync 接口',
    body: '旧的 sync 接口与新的 async 版本语义重复。\n\n- 删除 sync 分支\n- 补一条迁移说明',
    breaking: '调用方必须改用 async 版本',
    footers: ['Refs: #123', 'Co-authored-by: A <a@example.com>'],
  })
  const parsed = parseMessage(message)
  equal('parse type', parsed.type, 'refactor')
  equal('parse scope', parsed.scope, 'core')
  equal('parse bang', parsed.bang, true)
  equal('parse subject', parsed.subject, '移除已废弃的 sync 接口')
  includes('parse body', parsed.body, '删除 sync 分支')
  equal('parse breaking trailer', parsed.breaking, '调用方必须改用 async 版本')
  equal('parse footers', parsed.footers.join('|'), 'Refs: #123|Co-authored-by: A <a@example.com>')
  check('compose is idempotent', composeMessage(parsed) === message, 'round-trip differs')
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 规范校验
// ─────────────────────────────────────────────────────────────────────────────
const rules = { ...loadConventions(process.cwd(), { discover: false }).rules }

{
  const result = lintCommit({ type: 'feat', scope: 'parser', subject: '支持 YAML 锚点复用' }, rules)
  equal('valid commit has no errors', result.errors.length, 0)
}
hasCode('reject unknown type', lintCommit({ type: 'foo', subject: '添加导出接口' }, rules), 'type.unknown')
hasCode('reject missing type', lintCommit({ subject: '添加导出接口' }, rules), 'type.missing')
hasCode('reject placeholder subject', lintCommit({ type: 'fix', subject: '修改' }, rules), 'subject.placeholder')
hasCode('reject trailing period', lintCommit({ type: 'fix', subject: '修复空指针崩溃。' }, rules), 'subject.trailing-punctuation')
hasCode('reject colloquial subject', lintCommit({ type: 'fix', subject: '其实就是改了下登录' }, rules), 'subject.colloquial')
hasCode('reject english filler', lintCommit({ type: 'fix', subject: 'just fix some stuff' }, rules), 'subject.colloquial')
// 口语化不止语气词：口语动词、含糊名词、程度词、模糊限定词都要拦。
hasCode('reject spoken verb', lintCommit({ type: 'fix', subject: '搞一下缓存清理' }, rules), 'subject.colloquial')
hasCode('reject vague noun', lintCommit({ type: 'fix', subject: '调整侧栏里的东西' }, rules), 'subject.colloquial')
hasCode('reject intensifier', lintCommit({ type: 'fix', subject: '挺慢的查询改走索引' }, rules), 'subject.colloquial')
hasCode('reject hedge in body', lintCommit({ type: 'fix', subject: '修复查询超时', body: '估计是索引没命中。' }, rules), 'body.colloquial')
hasCode('reject vague quantity in body', lintCommit({ type: 'fix', subject: '修复查询超时', body: '清理了一堆临时文件。' }, rules), 'body.colloquial')
check(
  'facts are not hedges',
  lintCommit({ type: 'fix', subject: '修复并发写入', body: '冲突可能是由索引锁导致的，已在用例中复现。' }, rules).errors.length === 0,
  `errors: ${codes(lintCommit({ type: 'fix', subject: '修复并发写入', body: '冲突可能是由索引锁导致的，已在用例中复现。' }, rules)).join(',')}`,
)
check('整树 is not filler', lintCommit({ type: 'fix', subject: '整树同步不再逐条 stat' }, rules).errors.length === 0)
hasCode('reject embedded type', lintCommit({ type: 'fix', subject: 'feat: 添加导出接口' }, rules), 'subject.embedded-type')
hasCode('reject emoji', lintCommit({ type: 'fix', subject: '修复登录崩溃 👍' }, rules), 'subject.emoji')
hasCode('reject uppercase scope', lintCommit({ type: 'fix', scope: 'Parser', subject: '修复空指针崩溃' }, rules), 'scope.format')
hasCode('reject bad footer', lintCommit({ type: 'fix', subject: '修复空指针崩溃', footers: ['这个问题见 #12'] }, rules), 'footer.format')
hasCode('reject breaking as footer', lintCommit({ type: 'fix', subject: '修复空指针崩溃', footers: ['BREAKING CHANGE: 接口变了'] }, rules), 'breaking.in-footer')
hasCode('reject too-wide subject', lintCommit({ type: 'fix', subject: '修复'.repeat(40) }, rules), 'subject.too-wide')
hasCode('reject too-wide body', lintCommit({ type: 'fix', subject: '修复空指针崩溃', body: 'x'.repeat(200) }, rules), 'body.too-wide')
hasCode('reject body filler', lintCommit({ type: 'fix', subject: '修复空指针崩溃', body: '反正就是差不多能跑' }, rules), 'body.colloquial')

{
  const strict = { ...rules, language: 'zh' }
  hasCode('language zh rejects english subject', lintCommit({ type: 'fix', subject: 'fix the crash' }, strict), 'subject.language')
  const english = { ...rules, language: 'en', subjectLowerCase: true }
  hasCode('language en rejects cjk', lintCommit({ type: 'fix', subject: '修复崩溃' }, english), 'subject.language')
  hasCode('lowercase rule', lintCommit({ type: 'fix', subject: 'Fix the crash' }, english), 'subject.case')
  check('lowercase rule accepts imperative', lintCommit({ type: 'fix', subject: 'fix the crash' }, english).errors.length === 0)
}
{
  const scoped = { ...rules, scopes: ['core', 'ui'], requireScope: true }
  hasCode('scope required', lintCommit({ type: 'fix', subject: '修复空指针崩溃' }, scoped), 'scope.required')
  hasCode('scope not allowed', lintCommit({ type: 'fix', scope: 'api', subject: '修复空指针崩溃' }, scoped), 'scope.not-allowed')
  check('scope allowed passes', lintCommit({ type: 'fix', scope: 'ui', subject: '修复空指针崩溃' }, scoped).errors.length === 0)
}
{
  const banned = { ...rules, banned: ['补丁', 'hack'] }
  hasCode('custom banned words', lintCommit({ type: 'fix', subject: '打个补丁修崩溃' }, banned), 'subject.colloquial')
}
{
  const warning = lintCommit({ type: 'refactor', subject: '重命名解析器内部字段' }, rules)
  check('refactor without body warns', warning.warnings.some((item) => item.code === 'body.missing'), 'no body.missing warning')
}
{
  // 正文总字数：三级 —— 静默通过 / 告警通过 / 需要显式确认（confirm_length）。
  const capped = { ...rules, bodyMaxColumns: 0, bodyConfirmChars: 300, bodySoftChars: 200 }
  const under = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '背景：' + '字'.repeat(140) }, capped)
  check('body under soft passes silently', under.errors.length === 0 && under.warnings.every((item) => item.code !== 'body.soft-length'), `errors: ${codes(under).join(',')}`)
  const warned = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '背景：' + '字'.repeat(200) }, capped)
  check('body over soft warns and still commits', warned.errors.length === 0 && warned.warnings.some((item) => item.code === 'body.soft-length'), `errors: ${codes(warned).join(',')}`)
  const needsConfirm = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '背景：' + '字'.repeat(320) }, capped)
  hasCode('body over confirm threshold needs confirmation', needsConfirm, 'body.length-confirm')
  const confirmed = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '背景：' + '字'.repeat(320) }, capped, { confirmLength: true })
  check('confirm_length lets it through', confirmed.errors.length === 0, `errors: ${codes(confirmed).join(',')}`)
  check('confirmed length is recorded as a warning', confirmed.warnings.some((item) => item.code === 'body.length-confirmed'), `warnings: ${confirmed.warnings.map((i) => i.code).join(',')}`)
  check('confirm_length does not silence the soft warning path', lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '背景：' + '字'.repeat(200) }, capped, { confirmLength: true }).warnings.some((item) => item.code === 'body.soft-length'))
  check('body char gate off by default', lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '字'.repeat(900) }, rules).errors.every((item) => item.code !== 'body.length-confirm'))
  check('newlines do not count toward the threshold', lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '字'.repeat(90) + '\n\n' + '字'.repeat(90) }, capped).errors.length === 0)
  equal('parsed bodyConfirmChars', parseConventionsText('bodyConfirmChars: 800\nbodySoftChars: 600').rules.bodyConfirmChars, 800)
  equal('parsed bodyMaxChars alias', parseConventionsText('bodyMaxChars: 750').rules.bodyConfirmChars, 750)
  equal('parsed bodysoftlength alias', parseConventionsText('bodysoftlength: 600').rules.bodySoftChars, 600)
  check('bodySoftChars >= bodyConfirmChars throws', (() => {
    try {
      loadConventions(process.cwd(), { discover: false, rules: { bodyConfirmChars: 500, bodySoftChars: 600 } })
      return false
    } catch {
      return true
    }
  })())
}
{
  // config.rules 的键白名单必须覆盖全部规则：漏一个就会在启动期被误判为未知键。
  const all = readSettings({
    rules: {
      types: ['feat'],
      scopes: ['core'],
      requireScope: true,
      subjectMaxColumns: 60,
      subjectSoftColumns: 50,
      bodyMaxColumns: 80,
      bodyConfirmChars: 800,
      bodySoftChars: 600,
      language: 'zh',
      subjectLowerCase: true,
      requireBody: true,
      allowEmoji: true,
      firstPerson: true,
      banned: ['x'],
    },
  })
  equal('every rule key is accepted in config.rules', Object.keys(all.rules).length, 14)
}
{
  // 建议上限（告警）与硬上限（拒绝）是两条线：项目文档常写"≤ 30 字，硬上限 40 字"。
  const soft = { ...rules, subjectMaxColumns: 80, subjectSoftColumns: 60 }
  const long = lintCommit({ type: 'fix', subject: '修复'.repeat(20) }, soft)
  check('soft width warns at 80 columns', long.warnings.some((item) => item.code === 'subject.soft-width'), `warnings: ${long.warnings.map((item) => item.code).join(',')}`)
  check('soft width does not refuse', long.errors.length === 0, `errors: ${codes(long).join(',')}`)
  const short = lintCommit({ type: 'fix', subject: '修复登录崩溃' }, soft)
  check('no soft warning under the suggestion', !short.warnings.some((item) => item.code === 'subject.soft-width'))
  hasCode('hard cap still refuses', lintCommit({ type: 'fix', subject: '修复'.repeat(41) }, soft), 'subject.too-wide')
  check('soft limit off by default', lintCommit({ type: 'fix', subject: '修复'.repeat(40) }, rules).warnings.every((item) => item.code !== 'subject.soft-width'))
}
{
  // bodyMaxColumns: 0 = 不限制正文行宽（引用命令输出、一段一行的仓库风格）。
  const unlimited = { ...rules, bodyMaxColumns: 0 }
  const long = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '验证：' + 'x'.repeat(300) }, unlimited)
  check('body width off means no too-wide', long.errors.every((item) => item.code !== 'body.too-wide'), `errors: ${codes(long).join(',')}`)
  const limited = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '验证：' + 'x'.repeat(300) }, rules)
  hasCode('body width still checked by default', limited, 'body.too-wide')
  equal('parsed bodyMaxColumns 0', parseConventionsText('bodyMaxColumns: 0').rules.bodyMaxColumns, 0)
}
{
  const person = { ...rules, firstPerson: true }
  hasCode('first person refused in subject', lintCommit({ type: 'fix', subject: '我修了登录崩溃' }, person), 'subject.first-person')
  const bodyPerson = lintCommit({ type: 'fix', subject: '修复登录崩溃', body: '我改了判断顺序。' }, person)
  check('first person warned in body', bodyPerson.warnings.some((item) => item.code === 'body.first-person') && bodyPerson.errors.length === 0, `errors: ${codes(bodyPerson).join(',')}`)
  check('first person off by default', lintCommit({ type: 'fix', subject: '我修了登录崩溃' }, rules).errors.length === 0)
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. 规范文件解析与渲染
// ─────────────────────────────────────────────────────────────────────────────
{
  const parsed = parseConventionsText([
    '# 本仓库规则',
    'types: feat, fix, chore',
    'requireScope: true',
    'subjectMaxColumns: 50',
    'language: zh',
    'banned: 补丁',
    '这条自由文本要进提示词。',
    '而且拼错的键也别被吃掉：subjetcMaxColumns: 999',
  ].join('\n'))
  equal('parsed types', parsed.rules.types.join(','), 'feat,fix,chore')
  equal('parsed requireScope', parsed.rules.requireScope, true)
  equal('parsed subjectMaxColumns', parsed.rules.subjectMaxColumns, 50)
  equal('parsed language', parsed.rules.language, 'zh')
  equal('parsed banned', parsed.rules.banned.join(','), '补丁')
  includes('unknown key stays in prose', parsed.prose, 'subjetcMaxColumns')
  includes('free text stays in prose', parsed.prose, '自由文本')
}
{
  let threw = false
  try {
    parseConventionsText('subjectMaxColumns: 5')
  } catch {
    threw = true
  }
  check('out-of-range value throws', threw)

  const extra = parseConventionsText(['subjectSoftColumns: 60', 'subjectMaxColumns: 80', 'firstPerson: true', 'subjectSoftColumns: 0'].join('\n'))
  equal('parsed subjectSoftColumns', extra.rules.subjectSoftColumns, 0)
  const person = parseConventionsText('firstPerson: no')
  equal('parsed firstPerson false', person.rules.firstPerson, false)
  let mismatch = false
  try {
    loadConventions(process.cwd(), { discover: false, rules: { subjectSoftColumns: 90, subjectMaxColumns: 80 } })
  } catch {
    mismatch = true
  }
  check('soft >= max throws', mismatch)
}

const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-tool-git-'))
const repo = join(tempRoot, 'repo')
mkdirSync(join(repo, '.git'), { recursive: true })
mkdirSync(join(repo, '.dsh'), { recursive: true })
writeFileSync(
  join(repo, '.dsh', 'commit-conventions.md'),
  ['# 仓库规则', 'types: feat, fix', 'subjectMaxColumns: 40', '', '正文必须写清影响范围。'].join('\n'),
  'utf8',
)
{
  const resolved = loadConventions(repo, {})
  equal('repo file wins over defaults', resolved.rules.types.join(','), 'feat,fix')
  equal('repo file numeric rule', resolved.rules.subjectMaxColumns, 40)
  includes('repo file source recorded', resolved.source, 'commit-conventions.md')
  const rendered = renderConventions(resolved)
  includes('render lists effective types', rendered, 'feat')
  includes('render includes prose', rendered, '正文必须写清影响范围')
  includes('render names the source', rendered, 'commit-conventions.md')
  check('render has no template braces', !rendered.includes('{{'), 'rendered text contains {{')
}
equal('sanitize braces', sanitizePromptText('a {{cwd}} b'), 'a { {cwd}} b')
equal('fallback to defaults', loadConventions(join(tempRoot, 'missing'), {}).rules.types.join(','), DEFAULT_TYPES.join(','))

// ─────────────────────────────────────────────────────────────────────────────
// 4. shell 里的 git 写操作识别
// ─────────────────────────────────────────────────────────────────────────────
const guardCases = [
  ['git commit -m "改了下"', 'commit'],
  ['cd repo; git commit -m x', 'commit'],
  ['git add . && git commit -m x', 'commit'],
  ['git status; git commit -m x', 'commit'],
  ['git commit --amend', 'commit'],
  ['"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x', 'commit'],
  ['git -C D:\\work\\repo commit -m x', 'commit'],
  ['git --no-pager commit -m x', 'commit'],
  ['bash -c "git commit -m x"', 'commit'],
  ['pwsh -NoProfile -Command "git commit --amend"', 'commit'],
  ['Start-Process git -ArgumentList commit', 'commit'],
  ['env git merge --no-edit main', 'merge'],
  ['git merge feature', 'merge'],
  ['git commit-tree abc -m x', 'commit-tree'],
]
for (const [command, expected] of guardCases) {
  const hit = detectShellGitBlock(command)
  check(`detect: ${command}`, hit !== null && hit.subcommand === expected, hit === null ? 'no hit' : `hit ${hit.subcommand}`)
}

// 其余 git 命令一律放行：工具没有的动作被拦掉只会让人另找绕路，收益是负的。
const allowedCases = [
  'git status',
  'git status --short --branch',
  'git log --oneline -n 5',
  'git diff --stat',
  'git show HEAD',
  'git blame src/a.js',
  'git stash list',
  'git branch -a',
  'git tag -l',
  'git remote -v',
  'git config --get user.name',
  'git rev-parse --show-toplevel',
  'git ls-files',
  'git --version',
  'git clone --filter=blob:none --no-checkout https://github.com/Flotiarenor/Python-3.10.13 D:\\project\\Python\\work\\upstream',
  'git clone https://github.com/Flotiarenor/dsh-tool-git.git',
  'git push origin main',
  'git fetch --all --prune',
  'git pull --rebase',
  'git add -A',
  'git reset --hard HEAD~1',
  'git rebase main',
  'git cherry-pick abc123',
  'git revert HEAD',
  'git clean -fd',
  'git stash push -u',
  'git checkout main',
  'git switch -c feature/x',
  'git rm -r old',
  'git init',
  'git config core.hooksPath .githooks',
  'git remote add origin https://github.com/Flotiarenor/x.git',
  'git worktree add ../wt',
  'git submodule update --init --recursive',
  'git lfs install',
  'git bisect start',
  'git apply fix.patch',
  'git archive -o src.zip HEAD',
  'Write-Output "never run git commit in a shell"',
  'Get-Content notes.md | Select-String "git push"',
  'git grep "git commit"',
]
for (const command of allowedCases) {
  const hit = detectShellGitBlock(command)
  check(`allow: ${command}`, hit === null, hit === null ? '' : `blocked ${hit.subcommand}`)
}
equal('classify commit', classifyGitArgs(['commit', '-m', 'x']).blocked, true)
equal('classify commit through -C', classifyGitArgs(['-C', 'repo', 'commit']).blocked, true)
equal('classify clone', classifyGitArgs(['clone', 'https://x/y.git']).blocked, false)
equal('classify push', classifyGitArgs(['push', 'origin', 'main']).blocked, false)
equal('classify bare version', classifyGitArgs(['--version']).subcommand, null)
equal('classify bare version passes', classifyGitArgs(['--version']).blocked, false)

// ─────────────────────────────────────────────────────────────────────────────
// 5. argv 拼装与拒绝
// ─────────────────────────────────────────────────────────────────────────────
function plan(args) {
  return buildPlan(args, { defaultDir: repo })
}
function argvOf(args) {
  const built = plan(args)
  return built.ok ? built.argv.join(' ') : `REFUSED: ${built.errors.map((item) => item.code).join(',')}`
}

equal('argv status', argvOf({ action: 'status' }), 'status --short --branch -uall')
equal('argv diff staged', argvOf({ action: 'diff', staged: true }), 'diff --no-color --cached')
equal('argv log limit', argvOf({ action: 'log', limit: 5 }), 'log --no-color --max-count=5')
equal('argv ls_files default', argvOf({ action: 'ls_files' }), 'ls-files --cached')
equal('argv switch create', argvOf({ action: 'switch', branch: 'feature/x', create: true }), 'switch -c feature/x')
equal('argv push upstream', argvOf({ action: 'push', remote: 'origin', branch: 'main', setUpstream: true }), 'push --set-upstream origin main')
equal('argv reset soft', argvOf({ action: 'reset', mode: 'soft', ref: 'HEAD~1' }), 'reset --soft HEAD~1')
equal('argv add paths', argvOf({ action: 'add', paths: ['a.txt', 'dir b'] }), 'add -- a.txt dir b')
equal('argv tag list', argvOf({ action: 'tag' }), 'tag --list')
equal('argv clone', argvOf({ action: 'clone', url: 'https://github.com/o/r.git', dir: '../scratch' }), 'clone https://github.com/o/r.git ../scratch')
equal('argv clone depth+branch', argvOf({ action: 'clone', url: 'git@github.com:o/r.git', depth: 1, branch: 'main' }), 'clone --depth=1 --branch main git@github.com:o/r.git')
equal('argv clone scp form', argvOf({ action: 'clone', url: 'git@github.com:o/r.git' }), 'clone git@github.com:o/r.git')
check('clone without url refused', argvOf({ action: 'clone' }).startsWith('REFUSED'))
check('clone transport helper refused', argvOf({ action: 'clone', url: 'ext::sh -c whoami' }).startsWith('REFUSED'))
check('clone unknown scheme refused', argvOf({ action: 'clone', url: 'ftp://host/repo.git' }).startsWith('REFUSED'))
check('clone flag-shaped url refused', argvOf({ action: 'clone', url: '--upload-pack=calc' }).startsWith('REFUSED'))
check('clone flag-shaped dir refused', argvOf({ action: 'clone', url: 'https://x/y.git', dir: '--force' }).startsWith('REFUSED'))
check('clone rejects denied flag', !plan({ action: 'clone', url: 'https://x/y.git', flags: ['--upload-pack=calc'] }).ok)
check('clone kind is write', plan({ action: 'clone', url: 'https://x/y.git' }).kind === 'write')
check('argv add without paths refused', argvOf({ action: 'add' }).startsWith('REFUSED'))
check('commit action refused with hint', !plan({ action: 'commit' }).ok && plan({ action: 'commit' }).errors[0].code === 'action.commit')
check('unknown action refused', !plan({ action: 'frobnicate' }).ok)
check('unknown field refused', !plan({ action: 'status', turbo: true }).ok)
check('denied flag refused', !plan({ action: 'status', flags: ['--output=x'] }).ok)
check('unknown flag refused', !plan({ action: 'status', flags: ['--frobnicate'] }).ok)
check('flag value charset enforced', !plan({ action: 'log', flags: ['--grep=a b; rm -rf /'] }).ok)
check('hard reset needs confirm', !plan({ action: 'reset', mode: 'hard', ref: 'HEAD' }).ok)
check('hard reset with confirm ok', plan({ action: 'reset', mode: 'hard', ref: 'HEAD', confirm: true }).ok)
check('clean defaults to dry-run', plan({ action: 'clean' }).ok && plan({ action: 'clean' }).argv.includes('--dry-run'))
check('clean without confirm refused', !plan({ action: 'clean', dryRun: false }).ok)
check('bad ref refused', !plan({ action: 'show', ref: 'HEAD; rm -rf /' }).ok)
check('flag-like path refused', !plan({ action: 'add', paths: ['--force'] }).ok)
check('blame needs exactly one path', !plan({ action: 'blame' }).ok && !plan({ action: 'blame', paths: ['a', 'b'] }).ok)
check('kind of read action', plan({ action: 'status' }).kind === 'read')
check('kind of write action', plan({ action: 'add', all: true }).kind === 'write')
check('action catalog non-empty', actionNames().length > 20)
check('action kinds cover catalog', actionKinds().size === actionNames().length)

// ─────────────────────────────────────────────────────────────────────────────
// 6. 配置校验与渲染
// ─────────────────────────────────────────────────────────────────────────────
{
  const settings = readSettings({ shellGuard: 'off', maxOutputBytes: 2048, rules: { types: ['feat'] } })
  equal('settings shellGuard', settings.shellGuard, 'off')
  equal('shellGuard defaults to commit', readSettings({}).shellGuard, 'commit')
  equal('settings maxOutputBytes', settings.maxOutputBytes, 2048)
  equal('settings rules', settings.rules.types.join(','), 'feat')
  for (const bad of [{ guidance: 'loud' }, { shellGuard: 'always' }, { shellGuard: 'write' }, { timeoutMs: 1 }, { typo: 1 }, { rules: { nope: 1 } }]) {
    let threw = false
    try {
      readSettings(bad)
    } catch {
      threw = true
    }
    check(`settings reject ${JSON.stringify(bad)}`, threw)
  }
}
{
  const rendered = internals.renderGitResult({}, {
    ok: false,
    action: 'status',
    code: 128,
    command: 'git status',
    cwd: repo,
    stdout: '',
    stderr: 'fatal: not a git repository',
    truncated: false,
    spill: '',
    refused: '',
    failure: '',
    hint: 'This directory is not inside a git work tree; run git({ action: "init" }) or point `cwd` at the repository.',
  })
  includes('failure render', rendered[0].text, 'fatal: not a git repository')
  includes('failure render hint', rendered[0].text, '[hint]')
  const refused = internals.renderGitResult({}, {
    ok: false,
    action: '',
    code: -1,
    command: '',
    cwd: repo,
    stdout: '',
    stderr: '',
    truncated: false,
    spill: '',
    refused: 'path --force looks like a flag',
    failure: '',
    hint: '',
  })
  includes('refusal render', refused[0].text, 'REFUSED')
  const dry = internals.renderCommitResult({}, {
    ok: true,
    action: 'commit',
    committed: false,
    dryRun: true,
    sha: '',
    message: 'feat: 添加示例文件\n',
    problems: [],
    warnings: [],
    code: -1,
    command: '',
    cwd: repo,
    stdout: '',
    stderr: '',
    truncated: false,
    spill: '',
    refused: '',
    failure: '',
    hint: '',
  })
  includes('dry run render', dry[0].text, 'DRY-RUN')
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. 进程执行（node 回退后端：没有 subprocess 服务时走这条路）
// ─────────────────────────────────────────────────────────────────────────────
const executor = createExecutor(null, { timeoutMs: 30_000, maxOutputBytes: 4096 })

let gitAvailable = false
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' })
  gitAvailable = true
} catch {
  gitAvailable = false
}
check('node fallback runs git', gitAvailable)

if (gitAvailable) {
  const version = await executor.run({ argv: ['git', '--version'], cwd: repo })
  equal('exec exit code', version.exitCode, 0)
  includes('exec stdout', version.stdout, 'git version')

  const failing = await executor.run({ argv: ['git', 'rev-parse', '--show-toplevel'], cwd: tempRoot })
  check('exec reports non-zero exit', failing.exitCode !== 0 && failing.stderr !== '', `exit ${failing.exitCode}`)

  const slow = createExecutor(null, { timeoutMs: 700 })
  const started = Date.now()
  const timedOut = await slow.run({ argv: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'], cwd: repo })
  check('exec times out', timedOut.timedOut === true, `timedOut=${timedOut.timedOut} after ${Date.now() - started} ms`)

  const spilled = createExecutor(null, { maxOutputBytes: 64 })
  const big = await spilled.run({ argv: [process.execPath, '-e', 'process.stdout.write("x".repeat(500))'], cwd: repo })
  check('exec truncates oversized output', big.truncated === true)
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. apply()：注册、提示词段、shell 拦截
// ─────────────────────────────────────────────────────────────────────────────
function mockCtx() {
  const state = { sections: [], tools: new Map(), guards: [] }
  return {
    state,
    get: () => undefined,
    tools: {
      register(definition) {
        state.tools.set(definition.name, definition)
        return () => {}
      },
      guard(fn) {
        state.guards.push(fn)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        state.sections.push(section)
        return () => {}
      },
    },
  }
}

{
  const ctx = mockCtx()
  apply(ctx, {})
  check('registers git tool', ctx.state.tools.has('git'))
  check('registers git_commit tool', ctx.state.tools.has('git_commit'))
  equal('registers two prompt sections', ctx.state.sections.length, 2)
  equal('registers one guard', ctx.state.guards.length, 1)
  const conventionsSection = ctx.state.sections.find((section) => section.name === 'git:commit-conventions')
  check('conventions section is dynamic', typeof conventionsSection.text === 'function')
  const rendered = conventionsSection.text({ scope: { session: { header: { cwd: repo } } } })
  includes('conventions section uses repo types', rendered, 'feat (')
  includes('conventions section uses repo types (2)', rendered, 'fix (')
  check('conventions section drops removed types', !rendered.includes('docs ('), 'render still lists docs')
  includes('conventions section uses repo width', rendered, 'at most 40 display columns')
  const guard = ctx.state.guards[0]
  const denial = guard({ name: 'pwsh', arguments: { command: 'git commit -m "改了下"' } })
  check('guard denies git commit in pwsh', typeof denial === 'string' && denial.includes('git_commit'))
  check('guard allows read-only git', guard({ name: 'pwsh', arguments: { command: 'git status' } }) === undefined)
  check(
    'guard allows git clone',
    guard({ name: 'pwsh', arguments: { command: 'git clone --filter=blob:none --no-checkout https://github.com/Flotiarenor/Python-3.10.13 D:\\tmp\\up' } }) === undefined,
  )
  check('guard allows git push', guard({ name: 'pwsh', arguments: { command: 'git push origin main' } }) === undefined)
  check('guard allows git reset --hard', guard({ name: 'pwsh', arguments: { command: 'git reset --hard HEAD~1' } }) === undefined)
  check('guard denies git merge', typeof guard({ name: 'pwsh', arguments: { command: 'git merge feature' } }) === 'string')
  check('guard ignores other tools', guard({ name: 'read', arguments: { command: 'git commit' } }) === undefined)

  const settings = mockCtx()
  apply(settings, { shellGuard: 'off', guidance: false })
  equal('shellGuard off registers no guard', settings.state.guards.length, 0)
  equal('guidance false registers one section', settings.state.sections.length, 1)
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. 端到端：真实仓库上的 git / git_commit
// ─────────────────────────────────────────────────────────────────────────────
if (gitAvailable) {
  const run = (args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' })
  run(['init', '--initial-branch=main'])
  run(['config', 'user.name', 'Self Test'])
  run(['config', 'user.email', 'selftest@example.com'])
  run(['config', 'commit.gpgsign', 'false'])

  const ctx = mockCtx()
  apply(ctx, { timeoutMs: 30_000 })
  const gitTool = ctx.state.tools.get('git')
  const commitTool = ctx.state.tools.get('git_commit')
  const runCtx = { agent: { id: 'selftest', session: { header: { cwd: repo } } }, signal: undefined }

  writeFileSync(join(repo, 'a.txt'), 'hello\n', 'utf8')

  const status = await gitTool.execute({ action: 'status' }, runCtx)
  check('e2e status ok', status.ok === true, status.stderr || status.failure)
  includes('e2e status shows untracked file', status.stdout, 'a.txt')

  const before = run(['status', '--porcelain'])

  // 不合规：一条也不许落库
  const rejected = await commitTool.execute({ type: 'fix', subject: '其实就是改了下', paths: ['a.txt'] }, runCtx)
  check('e2e rejects colloquial subject', rejected.committed === false && rejected.refused !== '')
  check('e2e rejection carries problems', rejected.problems.some((line) => line.includes('subject.colloquial')))
  equal('e2e rejection staged nothing', run(['status', '--porcelain']), before)

  const dry = await commitTool.execute({ type: 'feat', subject: '添加示例文件', paths: ['a.txt'], dry_run: true }, runCtx)
  check('e2e dry run ok', dry.ok === true && dry.dryRun === true)
  equal('e2e dry run message', dry.message, 'feat: 添加示例文件\n')
  equal('e2e dry run stages nothing', run(['status', '--porcelain']), before)

  const committed = await commitTool.execute({
    type: 'feat',
    subject: '添加示例文件',
    body: '端到端用例需要一个可提交的文件。',
    paths: ['a.txt'],
  }, runCtx)
  check('e2e commit ok', committed.committed === true, committed.refused || committed.stderr || committed.failure)
  check('e2e commit returns sha', committed.sha !== '')
  equal('e2e recorded message equals composed message', run(['log', '-1', '--pretty=%B']).trim(), committed.message.trim())

  const again = await commitTool.execute({ type: 'fix', subject: '修复端到端用例' }, runCtx)
  check('e2e refuses empty commit', again.committed === false && again.refused.includes('nothing is staged'))
  equal('e2e still one commit', run(['rev-list', '--count', 'HEAD']).trim(), '1')

  const log = await gitTool.execute({ action: 'log', limit: 1, flags: ['--oneline'] }, runCtx)
  check('e2e log ok', log.ok === true && log.stdout.includes('添加示例文件'), log.stdout || log.stderr)

  const deniedFlag = await gitTool.execute({ action: 'diff', flags: ['--output=patch.diff'] }, runCtx)
  check('e2e denied flag refused', deniedFlag.refused !== '' && deniedFlag.refused.includes('not accepted'))
  check('e2e denied flag did not create a file', !existsSync(join(repo, 'patch.diff')))

  const outside = await gitTool.execute({ action: 'status', cwd: tempRoot }, runCtx)
  check('e2e not-a-repo is reported', outside.ok === false && outside.stderr.includes('not a git repository'))

  const badCwd = await gitTool.execute({ action: 'status', cwd: join(tempRoot, 'nope') }, runCtx)
  check('e2e missing cwd refused', badCwd.refused.includes('does not exist'))

  const file = readFileSync(join(repo, '.git', 'HEAD'), 'utf8')
  includes('e2e repository is intact', file, 'ref:')
}

rmSync(tempRoot, { recursive: true, force: true })

// ─────────────────────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failures.length
if (failures.length > 0) {
  console.error(`selftest: ${failures.length} of ${total} checks FAILED`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`selftest: ${passed}/${total} checks passed`)
