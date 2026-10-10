// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * message.mjs —— 提交信息的**拼装**与**校验**（纯函数，没有 I/O）。
 *
 * 设计前提：模型不写提交信息，只填字段。`git_commit` 的入参是结构化字段
 * （type / scope / subject / body / breaking / footers），这条路径上：
 *
 *   1. 格式不可能错——`type(scope): subject`、空行分段、trailer 段落都是拼出来的，不是模型敲的；
 *   2. 引号、换行、编码不可能错——信息走 `git commit -F -` 的 stdin，不经过任何 shell；
 *   3. 剩下的才是真正的语义问题：主题多长、是否口语化、是否只是"修改"两个字。这些在这里被**拒绝**
 *      （不是静默改写），每条错误都带 code / message / hint，模型据此改字段后重试。
 *
 * 有意为之的取舍：
 *   * 只在**不可能改变语义**的地方做规范化：去首尾空白、CRLF→LF、行尾空格、连续空格压成一个、
 *     行首行尾的空行。其余一律报错——"越改越对"是模型最容易犯的错，这里不给它这个机会。
 *   * 显示宽度按 CJK 记 2 列算：中文主题 36 字已经是 72 列，用字符数当列数会放过两倍超标。
 *   * 口语词是**子串**匹配的中文清单 + **词边界**匹配的英文清单：中文清单收录"其实就是/反正/试试"这类
 *     填充语，英文清单收录 just/stuff/kinda 这类词，避免把 "adjust" 里的 "just" 判成口语。
 */

import {
  BODY_FILLER_ZH,
  FILLER_EN,
  PLACEHOLDER_SUBJECTS,
  SUBJECT_FILLER_ZH,
  SUBJECT_NOISE,
} from './conventions.mjs'

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/
const EMOJI = /\p{Extended_Pictographic}/u
const ASCII_PRINTABLE = /^[\x20-\x7e]+$/
/** 已经是 `<type>(<scope>): ` 形状的主题：模型把整行塞进 subject 时的典型错误。 */
const EMBEDDED_TYPE = /^[a-z][a-z0-9-]*(\([^)]{0,40}\))?!?:\s/
const TRAILING_PUNCTUATION = /[.。!！~～…，,;；:：]$/
const TRAILER = /^([A-Za-z][A-Za-z0-9-]*)(: | #)\S/
const SCOPE_OK = /^[a-z0-9][a-z0-9._/-]*$/
const TYPE_OK = /^[a-z][a-z0-9-]*$/

/** 全角/宽字符的列宽：CJK、假名、谚文、全角标点、emoji 记 2，组合符与零宽记 0，其余记 1。 */
export function displayWidth(text) {
  let width = 0
  for (const char of String(text)) {
    const code = char.codePointAt(0)
    if (
      (code >= 0x0300 && code <= 0x036f)
      || (code >= 0x200b && code <= 0x200f)
      || code === 0xfeff
    ) {
      continue
    }
    if (
      (code >= 0x1100 && code <= 0x115f)
      || (code >= 0x2e80 && code <= 0x303e)
      || (code >= 0x3041 && code <= 0x33ff)
      || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff)
      || (code >= 0xa000 && code <= 0xa4cf)
      || (code >= 0xac00 && code <= 0xd7a3)
      || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xfe10 && code <= 0xfe19)
      || (code >= 0xfe30 && code <= 0xfe6f)
      || (code >= 0xff00 && code <= 0xff60)
      || (code >= 0xffe0 && code <= 0xffe6)
      || (code >= 0x1f300 && code <= 0x1faff)
      || (code >= 0x20000 && code <= 0x3fffd)
    ) {
      width += 2
      continue
    }
    width += 1
  }
  return width
}

function error(code, field, message, hint) {
  return { code, field, message, hint }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 命中的中文填充词（子串匹配）。 */
function fillerHits(text, list) {
  return list.filter((phrase) => text.includes(phrase))
}

/** 命中的英文口语词（词边界匹配，"adjust" 里的 "just" 不算）。 */
function wordHits(text) {
  const hits = []
  for (const word of FILLER_EN) {
    const pattern = new RegExp(`(^|[^A-Za-z])${escapeRegExp(word)}([^A-Za-z]|$)`, 'i')
    if (pattern.test(text)) hits.push(word)
  }
  return hits
}

/** 追加在规则之外被项目禁用的词：纯 ASCII 词按词边界，其余按子串。 */
function extraHits(text, banned) {
  return banned.filter((item) => {
    if (typeof item !== 'string' || item.trim() === '') return false
    const token = item.trim()
    if (/^[A-Za-z][A-Za-z '-]*$/.test(token)) {
      return new RegExp(`(^|[^A-Za-z])${escapeRegExp(token)}([^A-Za-z]|$)`, 'i').test(text)
    }
    return text.includes(token)
  })
}

function describeHits(hits) {
  return hits.map((hit) => JSON.stringify(hit)).join(', ')
}

/** 主题是否只是占位符（整体等于清单里的一项，去掉末尾标点后比较）。 */
function isPlaceholder(subject) {
  const normalized = subject
    .toLowerCase()
    .replace(/[\s.。,，!！~～…]+$/g, '')
    .trim()
  return PLACEHOLDER_SUBJECTS.includes(normalized)
}

/**
 * 入参规范化：只做不可能改变语义的清理。
 * @returns 归一后的字段（缺失的字段是空串 / 空数组，不是 undefined）。
 */
export function normalizeFields(input) {
  const raw = input === null || typeof input !== 'object' ? {} : input
  const text = (value) => (typeof value === 'string' ? value : '')
  const body = text(raw.body)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+|\n+$/g, '')
  return {
    type: text(raw.type).trim().toLowerCase(),
    scope: text(raw.scope).trim(),
    subject: text(raw.subject).trim().replace(/\s+/g, ' '),
    body,
    breaking: text(raw.breaking)
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/^\n+|\n+$/g, ''),
    footers: Array.isArray(raw.footers)
      ? raw.footers
        .filter((item) => typeof item === 'string')
        .map((item) => item.replace(/\s+/g, ' ').trim())
        .filter((item) => item !== '')
      : [],
  }
}

/** 由字段拼出完整提交信息（以换行结尾，交给 `git commit -F -`）。 */
export function composeMessage(input) {
  const fields = normalizeFields(input)
  const head = `${fields.type}${fields.scope === '' ? '' : `(${fields.scope})`}${fields.breaking === '' ? '' : '!'}: ${fields.subject}`
  const blocks = [head]
  if (fields.body !== '') blocks.push(fields.body)
  const trailers = []
  if (fields.breaking !== '') trailers.push(`BREAKING CHANGE: ${fields.breaking}`)
  trailers.push(...fields.footers)
  if (trailers.length > 0) blocks.push(trailers.join('\n'))
  return `${blocks.join('\n\n')}\n`
}

/**
 * 校验主题行（不含 type/scope）。合并提交与 tag 信息也用这一份规则。
 * @returns `{ errors, warnings }`
 */
export function lintSubjectLine(subject, rules, options = {}) {
  const errors = []
  const warnings = []
  const field = options.field ?? 'subject'
  const label = options.label ?? 'subject'
  const maxColumns = options.maxColumns ?? rules.subjectMaxColumns
  const text = String(subject)
  if (text === '') {
    errors.push(error(`${field}.missing`, field, `${label} is required`, `Pass a ${label} that names the change, not the file that changed.`))
    return { errors, warnings }
  }
  if (/[\r\n]/.test(text)) {
    errors.push(error(`${field}.newline`, field, `${label} must be a single line`, 'Move the extra lines into `body`.'))
  }
  const width = displayWidth(text)
  if (width > maxColumns) {
    errors.push(
      error(
        `${field}.too-wide`,
        field,
        `${label} is ${width} display columns, the limit is ${maxColumns} (CJK counts 2)`,
        `Cut ${width - maxColumns} columns: drop qualifiers, keep the subject a headline and move detail into \`body\`.`,
      ),
    )
  }
  // "建议上限"与"硬上限"分开：超过建议值只告警，超过硬上限才拒绝。项目文档常这么写
  // （"≤ 30 字，硬上限 40 字"），这里就按同一形状实现。
  const softColumns = options.softColumns ?? rules.subjectSoftColumns ?? 0
  if (softColumns > 0 && width > softColumns && width <= maxColumns) {
    warnings.push(
      error(
        `${field}.soft-width`,
        field,
        `${label} is ${width} display columns; this project asks for at most ${softColumns}`,
        `Trim about ${width - softColumns} columns if a shorter headline still names the change.`,
      ),
    )
  }
  if (TRAILING_PUNCTUATION.test(text)) {
    errors.push(
      error(
        `${field}.trailing-punctuation`,
        field,
        `${label} ends with ${JSON.stringify(text.slice(-1))}`,
        'Drop the trailing punctuation: a commit subject is a headline, not a sentence.',
      ),
    )
  }
  if (isPlaceholder(text)) {
    errors.push(
      error(
        `${field}.placeholder`,
        field,
        `${JSON.stringify(text)} says nothing about the change`,
        `Name what changed and why it matters, e.g. "fix(parser): 跳过空的 YAML 锚点" instead of ${JSON.stringify(text)}.`,
      ),
    )
  }
  const zhHits = [...fillerHits(text, SUBJECT_FILLER_ZH), ...fillerHits(text, BODY_FILLER_ZH)]
  const enHits = wordHits(text)
  const customHits = extraHits(text, rules.banned ?? [])
  const hits = [...new Set([...zhHits, ...enHits, ...customHits])]
  if (hits.length > 0) {
    errors.push(
      error(
        `${field}.colloquial`,
        field,
        `${label} contains filler wording: ${describeHits(hits)}`,
        'State the change itself; drop hedges, filler and spoken-language particles.',
      ),
    )
  }
  const noise = SUBJECT_NOISE.filter((item) => text.includes(item))
  if (noise.length > 0) {
    errors.push(error(`${field}.noise`, field, `${label} contains ${describeHits(noise)}`, 'Remove the decorative punctuation.'))
  }
  if (!rules.allowEmoji && EMOJI.test(text)) {
    errors.push(error(`${field}.emoji`, field, `${label} contains an emoji`, 'Drop the emoji; commit history is not a chat message.'))
  }
  if (rules.firstPerson === true && text.includes('我')) {
    errors.push(
      error(
        `${field}.first-person`,
        field,
        `${label} uses the first person ("我")`,
        'Name the change as the subject instead of the person: "修复 X" rather than "我修了 X".',
      ),
    )
  }
  if (rules.language === 'zh' && !CJK.test(text)) {
    errors.push(error(`${field}.language`, field, `${label} has no Chinese text but this project requires Chinese subjects`, 'Rewrite the subject in Chinese.'))
  }
  if (rules.language === 'en' && !ASCII_PRINTABLE.test(text)) {
    errors.push(error(`${field}.language`, field, `${label} must be plain ASCII English for this project`, 'Rewrite the subject in English.'))
  }
  if (rules.subjectLowerCase === true && rules.language !== 'zh') {
    const first = text.match(/[A-Za-z]/)
    if (first !== null && first[0] === first[0].toUpperCase()) {
      errors.push(error(`${field}.case`, field, `${label} starts with a capital letter`, 'Start the subject lowercase (imperative mood), e.g. "add ...".'))
    }
  }
  if (width > 0 && width < 8 && !isPlaceholder(text)) {
    warnings.push(error(`${field}.short`, field, `${label} is only ${width} display columns`, 'Consider naming the affected area (scope or subject) more precisely.'))
  }
  if (/^[A-Z0-9 _-]{6,}$/.test(text)) {
    warnings.push(error(`${field}.shouting`, field, `${label} is all capitals`, 'Use normal casing.'))
  }
  return { errors, warnings }
}

/** 校验正文：每行宽度、填充词、TODO 标记。 */
export function lintBody(body, rules) {
  const errors = []
  const warnings = []
  const text = String(body)
  if (text.trim() === '') return { errors, warnings }
  const lines = text.split('\n')
  const offenders = []
  // bodyMaxColumns 为 0 表示这个仓库不限制正文行宽（常见于"一个自然段一行 + 正文贴命令输出"的风格）。
  if (rules.bodyMaxColumns > 0) {
    lines.forEach((line, index) => {
      if (displayWidth(line) > rules.bodyMaxColumns) offenders.push({ line: index + 1, width: displayWidth(line) })
    })
  }
  if (offenders.length > 0) {
    const first = offenders[0]
    errors.push(
      error(
        'body.too-wide',
        'body',
        `${offenders.length} body line(s) exceed ${rules.bodyMaxColumns} columns (first: line ${first.line} at ${first.width})`,
        'Wrap the prose; keep code, paths and URLs on their own line even when they are longer.',
      ),
    )
  }
  const hits = [...fillerHits(text, BODY_FILLER_ZH), ...wordHits(text), ...extraHits(text, rules.banned ?? [])]
  const unique = [...new Set(hits)]
  if (unique.length > 0) {
    errors.push(error('body.colloquial', 'body', `body contains filler wording: ${describeHits(unique)}`, 'Describe cause and effect instead of narrating the work.'))
  }
  if (!rules.allowEmoji && EMOJI.test(text)) {
    errors.push(error('body.emoji', 'body', 'body contains an emoji', 'Drop the emoji.'))
  }
  if (/(^|\n)\s*(TODO|FIXME|XXX|WIP)\b/.test(text)) {
    warnings.push(error('body.marker', 'body', 'body still carries a TODO/FIXME/WIP marker', 'Either finish the work or move the note to an issue and reference it in a footer.'))
  }
  // 正文里的第一人称只告警：引述用户原话（"用户反馈'我看不到封面'"）是合理用法。
  if (rules.firstPerson === true && text.includes('我')) {
    warnings.push(
      error(
        'body.first-person',
        'body',
        'body narrates in the first person ("我")',
        'Let the change be the subject; keep the pronoun only inside a quoted message or a reproduction step.',
      ),
    )
  }
  return { errors, warnings }
}

/**
 * 完整校验一次结构化提交。
 *
 * @param input - `{ type, scope, subject, body, breaking, footers }`。
 * @param rules - 生效的规范（`loadConventions(...).rules`）。
 * @returns `{ fields, errors, warnings, message }`；`message` 是拼装结果，即使有错误也给出（用于预览）。
 */
export function lintCommit(input, rules) {
  const fields = normalizeFields(input)
  const errors = []
  const warnings = []

  if (fields.type === '') {
    errors.push(error('type.missing', 'type', 'type is required', `Pass one of: ${rules.types.join(', ')}.`))
  } else if (!TYPE_OK.test(fields.type)) {
    errors.push(error('type.format', 'type', `${JSON.stringify(fields.type)} is not a valid type token`, 'Use lowercase letters, digits and dashes only.'))
  } else if (!rules.types.includes(fields.type)) {
    errors.push(error('type.unknown', 'type', `${JSON.stringify(fields.type)} is not an allowed type`, `Use one of: ${rules.types.join(', ')}; pick the kind of change, not the file that changed.`))
  }

  if (fields.scope !== '') {
    if (!SCOPE_OK.test(fields.scope)) {
      errors.push(error('scope.format', 'scope', `${JSON.stringify(fields.scope)} is not a valid scope`, 'Lowercase, no spaces: letters, digits, dot, dash, slash, e.g. "parser" or "core/http".'))
    } else if (displayWidth(fields.scope) > 24) {
      errors.push(error('scope.too-long', 'scope', `scope is ${displayWidth(fields.scope)} columns, the limit is 24`, 'Pick the narrowest stable area name.'))
    } else if (rules.scopes.length > 0 && !rules.scopes.includes(fields.scope)) {
      errors.push(error('scope.not-allowed', 'scope', `${JSON.stringify(fields.scope)} is not an allowed scope`, `Use one of: ${rules.scopes.join(', ')}.`))
    }
  } else if (rules.requireScope) {
    errors.push(error('scope.required', 'scope', 'this project requires a scope', `Pass one of: ${rules.scopes.length > 0 ? rules.scopes.join(', ') : 'the narrowest area name'}.`))
  }

  const embedded = EMBEDDED_TYPE.exec(fields.subject)
  if (embedded !== null) {
    errors.push(
      error(
        'subject.embedded-type',
        'subject',
        'subject already starts with a type prefix',
        'Pass the type in `type` and only the description in `subject`; the tool builds the "type(scope): subject" head itself.',
      ),
    )
  } else {
    const subjectCheck = lintSubjectLine(fields.subject, rules)
    errors.push(...subjectCheck.errors)
    warnings.push(...subjectCheck.warnings)
  }

  if (fields.breaking !== '' && fields.breaking.trim() === '') {
    errors.push(error('breaking.empty', 'breaking', 'breaking is empty', 'Either drop the field or describe what breaks.'))
  }
  if (fields.footers.some((footer) => /^BREAKING[ -]CHANGE/i.test(footer))) {
    errors.push(
      error(
        'breaking.in-footer',
        'footers',
        'a BREAKING CHANGE trailer must not be passed as a footer',
        'Use the `breaking` field: the tool adds the "BREAKING CHANGE:" trailer and the "!" marker itself.',
      ),
    )
  }
  fields.footers.forEach((footer, index) => {
    if (!TRAILER.test(footer)) {
      errors.push(
        error(
          'footer.format',
          `footers[${index}]`,
          `${JSON.stringify(footer)} is not a git trailer`,
          'Use "<Token>: <value>" or "<Token> #<issue>", e.g. "Refs: #123", "Closes #42", "Co-authored-by: Name <mail>".',
        ),
      )
    }
  })

  if (fields.body === '') {
    if (rules.requireBody) {
      errors.push(error('body.required', 'body', 'this project requires a body', 'Explain why the change is made, not what the diff already shows.'))
    } else if (['refactor', 'perf', 'fix'].includes(fields.type)) {
      warnings.push(error('body.missing', 'body', `a ${fields.type} commit usually explains why`, 'Add 1-3 lines of body: the cause, the approach, or the tradeoff.'))
    }
  } else {
    const bodyCheck = lintBody(fields.body, rules)
    errors.push(...bodyCheck.errors)
    warnings.push(...bodyCheck.warnings)
    const firstBodyLine = fields.body.split('\n').find((line) => line.trim() !== '') ?? ''
    if (firstBodyLine.trim().toLowerCase() === fields.subject.toLowerCase()) {
      warnings.push(error('body.repeats-subject', 'body', 'body repeats the subject', 'Drop the repeated line or say something the subject does not.'))
    }
  }

  return { fields, errors, warnings, message: composeMessage(fields) }
}

/**
 * 解析一条提交信息（用于自测与"实际落库的信息是否等于拼装结果"的核对）。
 *
 * 字段与 `composeMessage` 的入参保持一致（`breaking` 是**文本**），另加两个只读标记：
 * `bang` 是主题行上的 `!`，`conforming` 是主题行是否符合 `type(scope): subject` 形状。
 * 这样 `composeMessage(parseMessage(x)) === x` 对任何合规范的消息都成立。
 *
 * @returns `{ type, scope, subject, body, breaking, footers, bang, conforming }`。
 */
export function parseMessage(message) {
  const text = String(message).replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  const lines = text.split('\n')
  const head = /^([a-z][a-z0-9-]*)(?:\(([^)]*)\))?(!)?: (.*)$/.exec(lines[0] ?? '')
  if (head === null) {
    return { type: '', scope: '', subject: '', body: '', breaking: '', footers: [], bang: false, conforming: false }
  }
  const rest = lines.slice(1)
  if (rest.length > 0 && rest[0].trim() === '') rest.shift()
  const paragraphs = rest.join('\n').split(/\n{2,}/).filter((block) => block.trim() !== '')
  const footers = []
  let breaking = ''
  if (paragraphs.length > 0) {
    const last = paragraphs[paragraphs.length - 1]
    const lastLines = last.split('\n')
    const trailerLines = lastLines.filter((line) => TRAILER.test(line) || /^BREAKING[ -]CHANGE: /.test(line))
    if (trailerLines.length === lastLines.length) {
      paragraphs.pop()
      for (const line of trailerLines) {
        if (/^BREAKING[ -]CHANGE: /.test(line)) breaking = line.replace(/^BREAKING[ -]CHANGE: /, '')
        else footers.push(line)
      }
    }
  }
  return {
    type: head[1],
    scope: head[2] ?? '',
    subject: head[4],
    body: paragraphs.join('\n\n'),
    breaking,
    footers,
    bang: head[3] === '!',
    conforming: true,
  }
}
