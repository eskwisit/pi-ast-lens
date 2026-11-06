# Code Compass for PI-Desktop

Code Compass makes the agent read code as code instead of grepping it as text.

- **`ast_grep`** — structural search and rewrite with [ast-grep](https://ast-grep.github.io).
  `fetch($URL, $$$)` finds every call of `fetch`, over several lines too, and never a hit in a
  comment or a string. Add `rewrite` to preview the same edit everywhere, `apply: true` to write it.
- **`lsp`** — asks the language server: definition, references, hover, implementation,
  type definition, file outline, workspace symbols and diagnostics.
- **Language from the file extension.** `.ts` starts the TypeScript server and parses as
  TypeScript, `.py` uses Pyright, `.go` gopls, `.rs` rust-analyzer, and so on. For a directory,
  `ast_grep` uses your globs or the most common code language under it.
- **Grep steering.** The agent's system prompt says when to use which tool. When the agent still
  greps code for an identifier, the result gets a one-line hint (mode `steer`, default), or the
  call is blocked (mode `strict`). Grep stays available for plain text: logs, comments, docs, config.

```
"Where is parseConfig used?"
  Grep  parseConfig            → every line with the text: calls, comments, log messages, parseConfigFile…
  lsp   references             → only the real uses of that symbol, with the source line of each

"Replace every console.log with logger.debug in src/"
  ast_grep  console.log($$$) → logger.debug($$$)   preview, then apply: true
  lsp       diagnostics on the changed files
```

## Requirements

Code Compass installs nothing. It uses the tools on your machine:

| For | Install |
| --- | --- |
| `ast_grep` | `npm i -g @ast-grep/cli` (any platform), `brew install ast-grep`, `scoop install main/ast-grep`, `cargo install ast-grep --locked` or `pip install ast-grep-cli` |
| `lsp` | the language server of each language you work in, see below |

When a tool is missing, the result gives the install command for your platform and the agent
carries on with `ast_grep` and Read.

## Platforms

Code Compass runs wherever PI-Desktop does: macOS (Apple silicon and Intel), Windows, and Linux
(x64 and arm64). It needs nothing beyond the tools above, not even Node: a language server
written in JavaScript runs with PI-Desktop's own runtime when `node` is not installed.

| | Finds tools in |
| --- | --- |
| all | `PATH`, the project's `node_modules/.bin`, `~/.cargo/bin`, `~/go/bin`, `~/.dotnet/tools`, `~/.bun/bin`, `~/.deno/bin` |
| macOS, Linux | your login shell's `PATH` too (apps started from the Dock or a desktop launcher get a short one), Homebrew and Linuxbrew, Homebrew's keg-only `llvm` (clangd), `~/.local/bin`, `/snap/bin`, nvm, fnm, Volta, asdf and mise shims, pnpm |
| Windows | `%APPDATA%\npm`, pnpm, Volta, Scoop, Chocolatey, WinGet links, `C:\Program Files\LLVM\bin`, Go, the Python `Scripts` folders |

On Windows, npm installs commands as `.cmd` shims. Code Compass runs the program behind the shim
directly, without `cmd.exe`, so an ast-grep pattern with `&`, `|`, `^`, `%` or quotes reaches
ast-grep unchanged. Other `.bat` launchers go through `cmd.exe` with every argument escaped.
Stopping a server stops all its child processes too (`taskkill /T` on Windows, the process group
elsewhere).

| Extensions | Language server (first one found) |
| --- | --- |
| `.ts .tsx .js .jsx .mjs .cjs .mts .cts` | TypeScript 7 `tsc --lsp` (project), `tsgo`, `typescript-language-server`, `vtsls` |
| `.py .pyi` | `basedpyright-langserver`, `pyright-langserver`, `pylsp`, `jedi-language-server` |
| `.go` | `gopls` |
| `.rs` | `rust-analyzer` |
| `.c .h .cc .cpp .cxx .hpp .m .mm` | `clangd` |
| `.swift` | `sourcekit-lsp` |
| `.java` / `.kt` | `jdtls` / `kotlin-language-server` |
| `.cs` | `csharp-ls`, `OmniSharp` |
| `.rb` | `ruby-lsp`, `solargraph` |
| `.php` | `intelephense`, `phpactor` |
| `.lua` `.sh` `.zig` `.ex` `.dart` `.hs` `.ml` `.scala` | `lua-language-server`, `bash-language-server`, `zls`, `elixir-ls`, `dart language-server`, `haskell-language-server-wrapper`, `ocamllsp`, `metals` |
| `.vue` `.svelte` `.tf` | `vue-language-server`, `svelteserver`, `terraform-ls` |
| `.css .scss .less` `.html` `.json` `.yaml` | `vscode-langservers-extracted`, `yaml-language-server` |

A server starts on first use, one per project root (the nearest `tsconfig.json`, `go.mod`,
`Cargo.toml`, `pyproject.toml`, …), and stops after 10 idle minutes or when the session ends.
Before it answers, Code Compass waits for the server's own start-up work (`$/progress`), so the
first references are complete.

## The tools

### `ast_grep`

| Parameter | |
| --- | --- |
| `pattern` | Code with metavariables: `$X` one node, `$$$` any number, `$_` one node without capture |
| `rule` | Instead of `pattern`: an ast-grep YAML rule, e.g. `kind: function_declaration` with `has:` / `inside:` |
| `path` | File or directory; default the project |
| `lang` | Override the inferred language |
| `globs` | Include/exclude, e.g. `["src/**", "!**/*.test.ts"]` |
| `rewrite`, `apply` | Replacement with the same metavariables; preview unless `apply: true` |
| `selector`, `strictness`, `max` | Passed to ast-grep; `max` defaults to 80 matches |

Output: one line per match, `path:line:col: source line`, then the captured metavariables.

### `lsp`

| `operation` | Needs |
| --- | --- |
| `definition`, `references`, `hover`, `implementation`, `type_definition` | `file`, `line`, and `symbol` (the name on that line) or `column` |
| `symbols` | `file` |
| `workspace_symbols` | `query`; optional `file` or `lang` to pick the server |
| `diagnostics` | `file` (re-read from disk, so it reflects the agent's last edit) |

Lines and columns are 1-based. Output: `path:line:col: source line` per location.

## Settings

`/code-compass` shows the mode, the ast-grep in use and the language server found for each
language in the project. `/code-compass mode steer|strict|off` sets the mode.

Both live in `config.json` under `~/.config/code-compass/` (macOS, Linux; `$XDG_CONFIG_HOME` if
set) or `%APPDATA%\code-compass\` (Windows). The file can also add or replace servers per
extension:

```json
{
  "mode": "steer",
  "servers": {
    "py": ["ruff", "server"],
    "gleam": ["gleam", "lsp"]
  }
}
```

## Install

Download `eskwisit.code-compass-<version>.piplug` from the
[releases](https://github.com/eskwisit/pi-code-compass/releases) and open it from the PI-Desktop
plugins page. Requires PI-Desktop 0.21 or later.

## Development

```sh
node --test tests/*.test.mjs
```

The end-to-end tests use the real `ast-grep`, `clangd` and `typescript-language-server`, and are
skipped when those are missing. The Windows launch logic (shims, `cmd.exe` escaping) is also
unit-tested on every platform. CI runs the suite on Linux x64 and arm64, macOS Apple silicon and
Intel, and Windows.

## License

Apache-2.0
