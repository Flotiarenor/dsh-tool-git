// SPDX-FileCopyrightText: 2026 Flotiarenor
// SPDX-License-Identifier: Apache-2.0
/**
 * exec.mjs —— 把一次 git 调用落到真实进程上。
 *
 * 优先走宿主的 `ctx.subprocess` 服务（**可选**依赖，用 `ctx.get` 取）：那条路径上的可执行文件解析、
 * 沙箱与终止语义都由宿主自己的实现负责，插件不重复造。服务缺席时（例如在没有该服务的组合里，
 * 或者自测脚本直接调用）退回 `node:child_process`，接口与返回值形状完全一致。
 *
 * 有意为之的取舍：
 *   * **数组传参**：argv 是数组，不经过 shell，所以路径里的空格、中文、`&` 都不需要转义，
 *     也没有第二层解析可以注入。
 *   * **固定环境**：`LC_ALL=C` 让失败信息固定为英文（本插件的解析与提示词都按英文写），
 *     `GIT_TERMINAL_PROMPT=0` 让凭据缺失立刻失败而不是等输入，`GIT_PAGER=cat` 关掉分页器，
 *     `GIT_OPTIONAL_LOCKS=0` 让只读命令不去抢索引锁（写命令的可选锁行为不变）。
 *   * **有上限的收集**：输出超过 `maxOutputBytes` 就截断并报告溢出文件路径（服务后端由宿主写溢出文件，
 *     node 后端没有溢出文件，只报截断）——一次 `git diff` 的全文不该全部进入模型上下文。
 *   * **超时**：`timeoutMs` 到点就终止子进程并如实报告 `timedOut`，而不是把"还在跑"当成成功。
 */

import { spawn } from 'node:child_process'

/** 交给 git 的固定环境变量。 */
export const GIT_ENV = Object.freeze({
  GIT_PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_PARAMETERS: undefined,
  LC_ALL: 'C',
  LANG: 'C',
  PAGER: 'cat',
})

function errorText(error) {
  if (error === null || error === undefined) return 'unknown failure'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

function buildEnv(extra) {
  const env = { ...process.env }
  for (const [key, value] of Object.entries(GIT_ENV)) {
    if (value === undefined) continue
    env[key] = value
  }
  if (extra !== undefined && extra !== null) Object.assign(env, extra)
  return env
}

/**
 * 创建一个执行器。
 *
 * @param ctx - 插件上下文（只用于 `ctx.get('subprocess')`，可以传 null：自测脚本就是这么用的）。
 * @param options - `{ timeoutMs, maxOutputBytes, spillBytes, graceMs, env }`。
 * @returns `{ run(spec) }`：`spec` 为 `{ argv, cwd, stdin?, signal? }`，
 *          返回 `{ exitCode, signal, stdout, stderr, truncated, spillPath, timedOut, failure }`。
 */
export function createExecutor(ctx, options = {}) {
  const timeoutMs = Number.isInteger(options.timeoutMs) ? options.timeoutMs : 120_000
  const maxOutputBytes = Number.isInteger(options.maxOutputBytes) ? options.maxOutputBytes : 64 * 1024
  const spillBytes = Number.isInteger(options.spillBytes) ? options.spillBytes : 4 * 1024 * 1024
  const graceMs = Number.isInteger(options.graceMs) ? options.graceMs : 5_000
  const extraEnv = options.env

  function service() {
    if (ctx === null || ctx === undefined || typeof ctx.get !== 'function') return null
    const found = ctx.get('subprocess')
    return found !== null && typeof found === 'object' && typeof found.spawn === 'function' ? found : null
  }

  async function runViaService(backend, spec) {
    const executable = await backend.resolveExecutable(spec.argv[0], undefined, spec.signal)
    const handle = backend.spawn({
      argv: [executable, ...spec.argv.slice(1)],
      cwd: spec.cwd,
      stdio: {
        stdin: spec.stdin === undefined ? 'ignore' : { data: spec.stdin },
        stdout: { maxBytes: maxOutputBytes, spill: { maxBytes: spillBytes } },
        stderr: { maxBytes: maxOutputBytes, spill: { maxBytes: spillBytes } },
      },
      graceMs,
      signal: spec.signal,
      env: buildEnv(extraEnv),
    })
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      return { exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, spillPath: '', failure: errorText(error) }
    }
    const stdout = handle.collected.stdout === undefined ? undefined : handle.collected.stdout.readFrom(0)
    const stderr = handle.collected.stderr === undefined ? undefined : handle.collected.stderr.readFrom(0)
    return {
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: stdout === undefined ? '' : stdout.text,
      stderr: stderr === undefined ? '' : stderr.text,
      truncated: Boolean((stdout !== undefined && stdout.lossy) || (stderr !== undefined && stderr.lossy)),
      spillPath: (stdout !== undefined && stdout.spillPath) || (stderr !== undefined && stderr.spillPath) || '',
      failure: '',
    }
  }

  function runViaNode(spec) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(spec.argv[0], spec.argv.slice(1), {
          cwd: spec.cwd,
          env: buildEnv(extraEnv),
          stdio: [spec.stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        resolve({ exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, spillPath: '', failure: errorText(error) })
        return
      }
      let stdout = ''
      let stderr = ''
      let truncated = false
      let settled = false
      const append = (chunk, target) => {
        const text = chunk.toString('utf8')
        if (target === 'out') {
          if (stdout.length + text.length > maxOutputBytes) {
            stdout += text.slice(0, Math.max(0, maxOutputBytes - stdout.length))
            truncated = true
            return
          }
          stdout += text
          return
        }
        if (stderr.length + text.length > maxOutputBytes) {
          stderr += text.slice(0, Math.max(0, maxOutputBytes - stderr.length))
          truncated = true
          return
        }
        stderr += text
      }
      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }
      child.stdout?.on('data', (chunk) => append(chunk, 'out'))
      child.stderr?.on('data', (chunk) => append(chunk, 'err'))
      child.on('error', (error) => {
        finish({ exitCode: null, signal: null, stdout, stderr, truncated, spillPath: '', failure: errorText(error) })
      })
      child.on('close', (code, signal) => {
        finish({ exitCode: code, signal, stdout, stderr, truncated, spillPath: '', failure: '' })
      })
      if (spec.stdin !== undefined && child.stdin !== null && child.stdin !== undefined) {
        child.stdin.end(spec.stdin, 'utf8')
      }
      if (spec.signal !== undefined) {
        const abort = () => {
          try {
            child.kill()
          } catch {
            /* 已经在退出 */
          }
        }
        if (spec.signal.aborted) abort()
        else spec.signal.addEventListener('abort', abort, { once: true })
      }
    })
  }

  async function run(spec) {
    const controller = new AbortController()
    let timedOut = false
    let timer = null
    const forward = () => controller.abort()
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) controller.abort()
      else spec.signal.addEventListener('abort', forward, { once: true })
    }
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }
    const call = { ...spec, signal: controller.signal }
    const backend = service()
    let result
    try {
      if (controller.signal.aborted) {
        result = { exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, spillPath: '', failure: 'the call was aborted before it started' }
      } else if (backend !== null) {
        result = await runViaService(backend, call)
      } else {
        result = await runViaNode(call)
      }
    } catch (error) {
      result = { exitCode: null, signal: null, stdout: '', stderr: '', truncated: false, spillPath: '', failure: errorText(error) }
    } finally {
      if (timer !== null) clearTimeout(timer)
      if (spec.signal !== undefined) spec.signal.removeEventListener('abort', forward)
    }
    return { ...result, timedOut }
  }

  return { run, timeoutMs, maxOutputBytes }
}
