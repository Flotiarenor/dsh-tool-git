// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * syntax.mjs —— 语法/加载检查：把每个 lib 模块 import 一遍。
 *
 * 本插件零依赖、无构建步骤，所以"能 import"就等于"能加载"。比 `node --check` 多一层：
 * 模块顶层代码（常量表、正则）也会被执行，写错的正则或引用了不存在的导出会在这里暴露。
 */

const modules = [
  '../lib/conventions.mjs',
  '../lib/message.mjs',
  '../lib/shellgit.mjs',
  '../lib/commands.mjs',
  '../lib/exec.mjs',
  '../lib/git.mjs',
]

let failed = 0
for (const specifier of modules) {
  try {
    const loaded = await import(specifier)
    const exports = Object.keys(loaded).sort()
    console.log(`ok   ${specifier} (${exports.length} exports)`)
  } catch (error) {
    failed++
    console.error(`FAIL ${specifier}: ${error && error.stack ? error.stack : error}`)
  }
}

if (failed > 0) {
  console.error(`syntax: ${failed} module(s) failed to load`)
  process.exit(1)
}
console.log('syntax: all modules load')
