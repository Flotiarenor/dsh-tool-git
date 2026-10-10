# @flotiarenor/dsh-tool-git

给 DeepSeek Harness 的两个模型工具：`git` 与 `git_commit`，外加一段**当前仓库实际生效的提交规范**提示词，以及一道 pwsh/bash 里的 git 拦截。

解决的问题是：模型提交时默认走 `pwsh` 敲 `git commit -m "改了下 xx"`。这条路有三个毛病——

1. **信息是现编的**：口语化、格式随意、经常是"修改/更新"两个字；
2. **信息要过一次 shell**：引号、换行、编码、路径空格都可能出错；
3. **规范只写在提示词里**：没有任何东西在检查它，模型这次记住了，下次忘了。

本插件把"提交"这件事从 shell 搬到工具里：信息由**结构化字段**拼装、**提交前校验**、经 stdin 送进 git，
不合规就**拒绝提交**（不改写、不猜测），并给出 code / 原因 / 改法。

```
git_commit({ type: "fix", scope: "parser", subject: "跳过空的 YAML 锚点", body: "空锚点会让节点类型推断走到 null 分支。", paths: ["src/parser.js"] })
        ↓ 插件拼装 + 校验
fix(parser): 跳过空的 YAML 锚点

空锚点会让节点类型推断走到 null 分支。
        ↓ git commit -F -（stdin，不过 shell）
COMMITTED 4f2c1a9
```

## 装了什么

| 组件 | 类型 | 作用 |
| --- | --- | --- |
| `git` | 工具 | 白名单子命令 + 具名参数；argv 由插件拼装，只读动作可并行调度 |
| `git_commit` | 工具 | 结构化字段 → 拼装信息 → 校验 → 提交（或 `dry_run` 预览） |
| `tool:git` | 提示词段（order 118） | 仓库操作走工具、不走 shell；被拒绝不等于要绕路 |
| `git:commit-conventions` | 提示词段（order 119） | **动态**：按会话目录解析出该仓库实际生效的规则与示例 |
| shell 拦截 | `ctx.tools.guard` | 拒绝 pwsh/bash 里会改仓库状态的 git 调用，并指出该用哪个动作 |

只注册**不与原生工具重名**的两个工具，原生 pwsh/bash 原样保留（只多一道 guard），回退就是给 preset 行加 `disabled: true`。

## `git` 工具

`action` 是唯一必填字段，各动作只读它自己声明过的字段。

**只读**：`status` `diff` `log` `show` `blame` `branch` `rev_parse` `ls_files` `stash_list` `remote` `config_get` `version`
**写**：`add` `restore` `switch` `stash` `fetch` `pull` `push` `merge` `revert` `cherry_pick` `reset` `rm` `mv` `tag` `clean` `init`
**看参数定性质**：`stash`（`list`/`show` 只读）、`tag`（不给 `name` 就是列标签）

约定：

* `paths` 是 pathspec，由插件加在 `--` 之后，所以"看起来像旗标的路径"不会变成旗标；
* `ref` 只接受 revision 形状（`HEAD~2`、`main`、`origin/main`、`v1.2.0`、`A...B`），`-` 开头或含空白的直接拒绝；
* `flags` 走**按动作的白名单**：`--diff-filter=M` 取 `--diff-filter` 判定，`--output` / `-c` / `-C` / `--git-dir` / `-m` / `--amend` / `--no-verify` 这类"改执行环境或重复具名字段"的旗标一律拒绝并列出该动作允许的旗标；
* `reset` 的 `hard` 需要 `confirm: true`；`clean` 默认 `dry_run: true`（先看列表），真删要 `confirm: true`；
* **没有 `commit` 动作**：给的是 `git_commit` 的提示，而不是一个能绕过校验的入口。

输出是 git 原文（`maxOutputBytes` 截断，溢出时给出溢出文件路径）；失败时附一行 `[hint]`：不是 git 仓库 / 没有暂存内容 / 没有 upstream / 冲突未解决 / hook 拒绝 / 认证失败。

## `git_commit` 工具

字段：`type`（必填）`subject`（必填）`scope` `body` `breaking` `footers` `paths` `all` `update` `amend` `signoff` `allow_empty` `dry_run` `cwd`。

* 信息由插件拼成 `<type>(<scope>): <subject>` + 空行 + 正文 + trailer 段；`breaking` 会自动补主题行的 `!` 与 `BREAKING CHANGE:` trailer。
* `dry_run: true` 只拼装 + 校验 + 回显信息，不碰仓库（想在提交前看一眼就用它）。
* 暂存：`paths` / `all` / `update`；暂存后**真的没有内容**就拒绝提交（不是提交一个空提交）。
* hooks **总是运行**；`no_verify` 默认被拒绝（`allowNoVerify: true` 才放行）。
* 提交后回读 `git log -1 --pretty=%B` 与拼装结果逐字比对，被 hook 改写会在结果里标 `[message.rewritten]`。

### 会被拒绝的东西

| code | 例子 |
| --- | --- |
| `type.missing` / `type.unknown` | `type: "foo"`，或忘了传 `type` |
| `scope.format` / `scope.not-allowed` / `scope.required` | `scope: "Parser"`；项目限定 scope 时给了别的；项目要求 scope 时没给 |
| `subject.missing` | 没有主题 |
| `subject.too-wide` | 主题超过 `subjectMaxColumns`（**CJK 记 2 列**，所以中文约 36 字就是 72 列） |
| `subject.trailing-punctuation` | `修复空指针崩溃。` |
| `subject.placeholder` | `修改` / `更新` / `update` / `wip` 这类等于没说的主题 |
| `subject.colloquial` | `其实就是改了下`、`顺便修个 bug`、`just fix some stuff`（会点名命中的词） |
| `subject.embedded-type` | `subject: "feat: 添加接口"`（type 交给 `type` 字段） |
| `subject.emoji` / `subject.noise` | emoji、`!!!`、`……` |
| `subject.first-person` | `firstPerson: true` 时 subject 里出现"我" |
| `subject.language` | 项目写 `language: zh` 却给了英文主题（或反过来） |
| `body.too-wide` / `body.colloquial` / `body.required` | 正文超宽、带填充语、项目要求正文却没写 |
| `footer.format` | `这个问题见 #12`（trailer 要 `<Token>: <value>` 或 `<Token> #<issue>`） |
| `breaking.in-footer` | 把 `BREAKING CHANGE:` 当 footer 传（用 `breaking` 字段） |
| `arg.unknown` | 传了不存在的字段 |

警告（不阻止）：`body.missing`（`fix`/`refactor`/`perf` 没写正文）、`subject.soft-width`（超过 `subjectSoftColumns` 的建议上限）、`subject.short`、`subject.shouting`、`body.first-person`（`firstPerson: true` 时正文出现"我"）、`body.marker`（还留着 TODO）、`body.repeats-subject`。

<a id="conventions-keys"></a>

## 提交规范：默认 + 仓库覆盖

优先级：**内置默认 < profile 行 `config.rules` < 仓库内规范文件**。

本节的锚点是 `#conventions-keys`：**别的项目要引用这套规则时直接链过来**，不必把规则抄一遍
（例：`https://github.com/Flotiarenor/dsh-tool-git/blob/main/README.zh.md#conventions-keys`）。

内置默认是 Conventional Commits：`feat fix docs style refactor perf test build ci chore revert`，scope 可选、
主题 ≤ 72 显示列、无句末标点、无口语填充、非占位符，正文 ≤ 100 列。

仓库里放一份 `.dsh/commit-conventions.md` 即可覆盖（找的是**会话目录**，找不到再找**仓库根**；最近的胜出）：

```markdown
# 本仓库提交规范

types: feat, fix, docs, chore        # 限定 type
scopes: core, ui, api                # 非空则 scope 必须取自这里
requireScope: true
subjectMaxColumns: 60                # 硬上限，显示宽度，CJK 记 2 列
subjectSoftColumns: 50               # 建议上限：超过只告警，不拒绝（0 = 不设，默认 0）
bodyMaxColumns: 100                  # 0 = 不限制正文行宽（贴命令输出的仓库常用）
language: zh                         # any | zh | en
subjectLowerCase: false
requireBody: true
allowEmoji: false
firstPerson: false                   # true = subject 里出现"我"直接拒绝，正文里只告警
banned: 补丁, 临时, hack              # 追加要拒绝的词（中文按子串、英文按词边界）

其余自由文本原样进提示词，例如：正文必须写清影响范围与回滚方式。
```

* 只认已知键；**拼错的键名不会被静默吃掉**，会留在自由文本里，模型仍能看到。
* 已知键取值非法（`subjectMaxColumns: 5`）会**抛错**——写错的规则应当立刻可见，而不是悄悄退回默认值。
* 查找顺序：`.dsh/commit-conventions.md`、`.dsh/git-conventions.md`、`.dsh/commit.md`、
  `.commit-conventions.md`、`.git-commit-conventions.md`、`docs/commit-conventions.md`（可用 `conventionsFiles` 改）。
* 仓库里有 commitlint 配置时，提示词会点出来（hooks 会再校验一次，hook 的输出原样回传）。

## 配置

preset 行 / bundle 行的 `config:` 原样透传（本插件没有 Config schema）。写错的键是**启动期错误**。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `timeoutMs` | `120000` | 单次 git 调用的墙钟上限 |
| `maxOutputBytes` | `65536` | 单次输出上限，超出即截断并报告溢出文件 |
| `spillBytes` | `4194304` | 宿主溢出文件上限 |
| `guidance` | `'full'` | `'short'` 去掉"别绕路"那半段；`false` 不注册用法段 |
| `conventions` | `'repo'` | `'builtin'` 表示不读仓库内规范文件 |
| `conventionsFiles` | 见上 | 覆盖查找顺序 |
| `maxProseBytes` | `4096` | 规范文件自由文本上限 |
| `shellGuard` | `'write'` | `'off'` 不注册拦截 |
| `guardTools` | `['pwsh','bash']` | 拦哪些工具 |
| `allowNoVerify` | `false` | 是否允许 `git_commit` 传 `no_verify` |
| `rules` | `{}` | 覆盖内置规范（`types` / `scopes` / `requireScope` / `subjectMaxColumns` / `subjectSoftColumns` / `bodyMaxColumns` / `language` / `subjectLowerCase` / `requireBody` / `allowEmoji` / `firstPerson` / `banned`；`subjectSoftColumns` 与 `bodyMaxColumns` 取 `0` 表示关闭该项） |

## 安装与卸载

```powershell
# 安装（bundle 层 = 所有会话可见，含 shell 拦截）
dsh plugin --profile desktop add link:D:/project/dsh-tool-git
# 或在 GUI 的插件管理里安装 link:D:/project/dsh-tool-git 并启用

# 卸载
dsh plugin --profile desktop remove @flotiarenor/dsh-tool-git
```

只想给某一个 preset 用（不要全局拦截）时，改为在该 preset 的 `plugins:` 列表里插一行
`- id: tool-git` / `name: '@flotiarenor/dsh-tool-git'`，别把它加进 profile 的 `dsh.profile.bundles`。

## 已知限制

* **拦截是约束，不是沙箱。** 别名、把命令藏进多层字符串、或用别的程序间接调用 git，都能绕过；
  真正的边界是"提交信息由工具拼装"这件事本身，而不是那条 guard。
* `git` 工具不是 git 的完整包装：`rebase`、`clone`、`submodule`、`worktree`、`bisect`、`lfs`、`apply`、`am`
  这些没有动作，shell 里也被拦（fail-closed），模型会明确说"工具不支持，请你来跑"，而不是绕路。
* 校验是**拒绝**而不是改写：主题超宽不会自动截断。这是有意的——静默改写会把模型的原意改掉，
  而且它学不到规则。
* 口语清单是**枚举**：中文按子串、英文按词边界。新词需要加进 `lib/conventions.mjs`，或用仓库文件的 `banned` 追加。
* 规范文件是**同步读**（提示词段的 text 回调是同步签名），按 mtime + size 缓存；文件都在 64 KB 以内。
* 一次 `git diff` 的全文可能很长，默认 64 KB 截断；要全文请读溢出文件或缩小范围（`paths` / `--stat`）。

## 自测

```powershell
node tools/selftest.mjs     # 171 项：纯函数 / argv / shell 识别 / 真实仓库端到端
node tools/syntax.mjs       # 每个模块都能 import
node tools/inspect.mjs <repo>   # 打印会注入上下文的全部文本与字数
```

端到端部分会在系统临时目录里建仓库、真的提交一次，并核对：合规字段能提交且落库信息逐字等于拼装结果、
不合规字段一条也不落库、`dry_run` 不产生提交、无暂存内容时拒绝提交。没有 git 时这一节跳过（其余断言照跑）。

## 许可

Apache-2.0。
