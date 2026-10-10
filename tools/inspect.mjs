// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * inspect.mjs —— 打印本插件会注入到模型上下文里的全部文本（工具描述 + 提示词段），
 * 以及每段的字符数，用来检查"约束写清楚了"和"上下文没被撑爆"。
 *
 *   node tools/inspect.mjs [仓库目录]
 */

import { apply, internals } from '../lib/git.mjs'

const cwd = process.argv[2] ?? process.cwd()

const state = { sections: [], tools: new Map(), guards: [] }
const ctx = {
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

apply(ctx, {})

const scope = { session: { header: { cwd } } }
console.log(`cwd: ${cwd}\n`)
for (const section of state.sections) {
  const text = typeof section.text === 'function' ? section.text({ scope }) : section.text
  console.log(`── prompt section ${section.name} (order ${section.order}, ${text.length} chars) ${'─'.repeat(20)}`)
  console.log(text)
  console.log('')
}
for (const [toolName, definition] of state.tools) {
  const schema = JSON.stringify(definition.parameters)
  console.log(`── tool ${toolName}: description ${definition.description.length} chars, parameters ${schema.length} chars, timeout ${definition.timeoutMs} ms ──`)
  console.log(definition.description)
  console.log('')
}
console.log(`── guard ──`)
console.log(state.guards[0]({ name: 'pwsh', arguments: { command: 'cd repo && git add . && git commit -m "改了点东西"' } }))
console.log('')
console.log(`── parameter schema ──`)
console.log(JSON.stringify(internals.GIT_PARAMETERS, null, 1).slice(0, 400))
