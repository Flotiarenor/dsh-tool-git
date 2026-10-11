# @flotiarenor/dsh-tool-git

Two DeepSeek Harness model tools — `git` and `git_commit` — plus a prompt section carrying the commit
conventions that are **actually in effect for the current repository**, and a pwsh/bash guard.

The problem it removes: the model's default route to a commit is `pwsh` running
`git commit -m "fixed some stuff"`. That route has three defects — the message is improvised (colloquial,
unstructured, often the two characters "修改"), the message has to survive a shell (quoting, newlines,
encoding, spaces in paths), and the conventions live only in a prompt that nothing verifies.

This plugin moves committing out of the shell and into a tool: the message is **composed from structured
fields**, **validated before anything is written**, and handed to git over stdin. A violation is
**refused** with a code, a reason and a fix — never silently rewritten.

```
git_commit({ type: "fix", scope: "parser", subject: "skip empty YAML anchors", body: "An empty anchor sent type inference down the null branch.", paths: ["src/parser.js"] })
        ↓ compose + validate
fix(parser): skip empty YAML anchors

An empty anchor sent type inference down the null branch.
        ↓ git commit -F - (stdin, no shell)
COMMITTED 4f2c1a9
```

## What it installs

| Piece | Kind | Purpose |
| --- | --- | --- |
| `git` | tool | Whitelisted subcommands with named arguments; the argv is built here, read actions may run in parallel |
| `git_commit` | tool | Structured fields → composed message → validation → commit (or `dry_run` preview) |
| `tool:git` | prompt section (order 118) | Repository work goes through the tool, not a shell; a refusal is not a detour to route around |
| `git:commit-conventions` | prompt section (order 119) | **Dynamic**: the rules and examples in effect for the session's repository |
| shell guard | `ctx.tools.guard` | Refuses the commands that write a commit message (`commit` / `merge` / `commit-tree`) and names the replacement call; every other git command runs in the shell as usual |

Both tools are new names (nothing native is shadowed), so the fallback is one `disabled: true` on the row.

## The `git` tool

`action` is the only required field; each action reads only the fields it documents.

**Read**: `status` `diff` `log` `show` `blame` `branch` `rev_parse` `ls_files` `stash_list` `remote` `config_get` `version`
**Write**: `add` `restore` `switch` `stash` `fetch` `pull` `push` `merge` `revert` `cherry_pick` `reset` `rm` `mv` `tag` `clean` `clone` `init`
**Depends on the arguments**: `stash` (`list`/`show` are reads), `tag` (no `name` lists tags)

Conventions:

* `paths` are pathspecs appended after `--` by the tool, so a path that looks like a flag cannot become one;
* `ref` accepts revision shapes only (`HEAD~2`, `main`, `origin/main`, `v1.2.0`, `A...B`);
* `flags` go through a **per-action allowlist** (`--diff-filter=M` is judged as `--diff-filter`); flags that
  change git's execution environment or duplicate a named field (`-c`, `-C`, `--git-dir`, `-m`, `--amend`,
  `--output`, `--no-verify`, ...) are refused with the allowed list;
* `reset` with `hard` requires `confirm: true`; `clean` defaults to `dry_run: true`;
* **no `commit` action** — the refusal points at `git_commit` instead of offering a way around validation.

Output is raw git output (capped at `maxOutputBytes`, with the spill file path when it overflows); failures
carry one `[hint]` line: not a repository / nothing staged / no upstream / unresolved conflicts / hook
rejection / authentication failure.

## The `git_commit` tool

Fields: `type` (required) `subject` (required) `scope` `body` `breaking` `footers` `paths` `all` `update`
`amend` `signoff` `allow_empty` `dry_run` `cwd`.

* The message is composed as `<type>(<scope>): <subject>` + blank line + body + trailer block; `breaking`
  adds the `!` marker and the `BREAKING CHANGE:` trailer.
* `dry_run: true` composes, validates and returns the message without touching the repository.
* Staging via `paths` / `all` / `update`; when nothing would be committed the tool refuses instead of
  creating an empty commit.
* Hooks always run; `no_verify` is refused unless the profile sets `allowNoVerify: true`.
* After committing, the tool re-reads `git log -1 --pretty=%B` and compares it with the composed message;
  a rewrite is reported as `[message.rewritten]`.

Refusals include: unknown/missing type, invalid scope, missing or over-wide subject (a CJK character counts
2 columns), trailing punctuation, placeholder subjects ("update", "修改"), spoken-language wording — spoken
verbs, vague nouns, intensifiers and hedges, with the matched words named — an embedded type prefix, emoji,
a first-person subject, language mismatch, over-wide or colloquial body, malformed trailers,
`BREAKING CHANGE:` passed as a footer, and unknown fields.
A subject over `subjectSoftColumns`, or a body over `bodySoftChars`, is only a warning; a body over
`bodyConfirmChars` is refused **once** and goes through on a re-call that passes `confirm_length: true`
(the confirmed call is reported as `body.length-confirmed`).

<a id="conventions-keys"></a>

## Conventions: defaults + per-repository override

Precedence: **built-in defaults < profile-row `config.rules` < repository conventions file**.

This section's anchor is `#conventions-keys`: a project can **link here instead of copying the rules**
(e.g. `https://github.com/Flotiarenor/dsh-tool-git/blob/main/README.md#conventions-keys`).

The built-in default is Conventional Commits with 11 types, optional lowercase scope, subject ≤ 72 display
columns, no trailing punctuation, no filler, body ≤ 100 columns. A repository overrides it with
`.dsh/commit-conventions.md` (session directory first, then the repository root; the nearest file wins):

```markdown
# Conventions

types: feat, fix, docs, chore
scopes: core, ui, api
requireScope: true
subjectMaxColumns: 60
subjectSoftColumns: 50      # suggested cap: over it is reported as a warning (0 = off, the default)
bodyMaxColumns: 100         # 0 = no body line-width limit
bodySoftChars: 600          # suggested body length: over it is only a warning
bodyConfirmChars: 800       # over it the call must pass confirm_length (not a hard cap)
language: zh
subjectLowerCase: false
requireBody: true
allowEmoji: false
firstPerson: false          # true = a first-person "我" in the subject is refused, in the body reported
banned: 补丁, 临时, hack

Free text goes into the prompt verbatim, e.g. the body must state the impact and the rollback.
```

Unknown keys are not swallowed — they stay in the free text. A known key with an invalid value throws:
a wrong rule should be visible, not silently replaced by the default.

## Configuration

The row's `config:` is passed through verbatim (no Config schema). A mistyped key is a startup error.

| Key | Default | Meaning |
| --- | --- | --- |
| `timeoutMs` | `120000` | wall-clock limit per git call |
| `maxOutputBytes` | `65536` | output cap per call |
| `spillBytes` | `4194304` | host spill-file cap |
| `guidance` | `'full'` | `'short'` trims the "do not route around it" half; `false` skips the section |
| `conventions` | `'repo'` | `'builtin'` ignores repository convention files |
| `conventionsFiles` | see above | override the lookup order |
| `maxProseBytes` | `4096` | cap for the free text taken from a conventions file |
| `shellGuard` | `'commit'` | blocks only `git commit` / `git merge` / `git commit-tree`; `'off'` disables the guard |
| `guardTools` | `['pwsh','bash']` | which tools the guard inspects |
| `allowNoVerify` | `false` | whether `git_commit` may pass `no_verify` |
| `rules` | `{}` | override the built-in rules (`types` / `scopes` / `requireScope` / `subjectMaxColumns` / `subjectSoftColumns` / `bodyMaxColumns` / `language` / `subjectLowerCase` / `requireBody` / `allowEmoji` / `firstPerson` / `banned`; `subjectSoftColumns` and `bodyMaxColumns` take `0` to switch that check off) |

## Install / uninstall

```powershell
dsh plugin --profile desktop add link:D:/project/dsh-tool-git
dsh plugin --profile desktop remove @flotiarenor/dsh-tool-git
```

Installing it as a bundle (as above) registers the tools, the prompt sections **and** the shell guard for
every session in the profile. To scope it to one preset instead, insert
`- id: tool-git` / `name: '@flotiarenor/dsh-tool-git'` into that preset's `plugins:` list and keep it out of
`dsh.profile.bundles`.

## Known limits

* The guard is a **constraint, not a sandbox**: aliases, nested strings and indirect calls can get around it.
  The real boundary is that the commit message is composed by the tool.
* The tool is not a full git wrapper: `rebase`, `submodule`, `worktree`, `bisect`, `lfs`, `apply` and `am`
  have no action — but they **do** run in the shell. Blocking operations the tool cannot express only
  pushes callers toward a detour.
* The shell guard covers exactly three commands: `commit`, `merge`, `commit-tree`. `git commit -m "<prose>"`
  is closed off, so a message has to go through `git_commit`; `add`, `push`, `reset --hard` or `clean -fd`
  are not intercepted.
* Validation **refuses** rather than rewrites: an over-wide subject is not truncated. Silent rewriting would
  change the author's meaning and teach the model nothing.
* The filler lists are enumerations (Chinese by substring, English by word boundary); extend them in
  `lib/conventions.mjs` or per repository with `banned`.
* Conventions files are read synchronously (the prompt-section `text` callback is synchronous) and cached by
  mtime + size; they are capped at 64 KB.

## Self-test

```powershell
node tools/selftest.mjs         # 171 checks: pure functions, argv, shell detection, real-repository e2e
node tools/syntax.mjs           # every module imports
node tools/inspect.mjs <repo>   # print every injected text and its size
```

The end-to-end part creates a repository in the system temp directory and really commits once, asserting that
a conforming call commits with a message identical to the composed one, that a non-conforming call commits
nothing, that `dry_run` produces no commit, and that an empty index is refused. It is skipped when git is
unavailable.

## License

Apache-2.0.
