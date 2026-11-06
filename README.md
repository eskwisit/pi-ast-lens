# Code Compass for PI-Desktop

PI-Desktop's agent finds code with Grep, Glob and Read. These tools see text, not code. Code
Compass adds two tools that understand code: **`ast_grep`** (syntax trees) and **`lsp`** (the
language server of your project). The agent gets fewer and more correct results, and it reads
less code to find the answer.

## What it adds to PI-Desktop

| The agent wants to know | Without Code Compass | With Code Compass |
| --- | --- | --- |
| Where is `parseConfig` used? | Grep: every line with the text, also comments, strings, JSON files, `parseConfigFile` and other symbols with the same name | `lsp references`: the real uses only, also in other `tsconfig` projects of a monorepo |
| What is `parseConfig`? | Read the file | `lsp hover`: type, signature and docs. `lsp symbols`: the outline of the file |
| Where is every `fetch(…)` call? | A Grep regex: misses calls over several lines, hits comments | `ast_grep fetch($URL, $$$)`: every call, by syntax |
| Make the same change in 40 files | 40 Edit calls | One `ast_grep` rewrite: preview, then `apply: true` |
| Did my edit break the types? | Run the build with Bash | `lsp diagnostics` on the file |

- **Language from the file extension.** `.ts` starts the TypeScript server and parses as
  TypeScript, `.py` uses Pyright, `.go` gopls, `.rs` rust-analyzer, and so on. For a directory,
  `ast_grep` uses your globs or the most common code language under it.
- **Grep steering.** The agent's system prompt says when to use which tool. When the agent still
  greps code for an identifier, the result gets a one-line hint (mode `steer`, default), or the
  call is blocked (mode `strict`). Grep stays available for plain text: logs, comments, docs, config.

## Measured

The measurement used the 8 exported classes and functions with the most text hits, in a
TypeScript monorepo with 343 files and 31 `tsconfig.json` files. It ran on Linux with
`typescript-language-server` (TypeScript 6) and ripgrep, the search engine of PI-Desktop's
Grep. Sizes are the characters of the tool output that the agent reads; at about 4 characters per
token, 4,000 characters are about 1,000 tokens.

**Tool output, total for the 8 symbols**

| Question | Without Code Compass | With Code Compass | Change |
| --- | ---: | ---: | ---: |
| Where is X used? | Grep, plain name: 69,464 | `lsp references`: 32,698 | −53% |
| | Grep, whole word: 35,539 | `lsp references`: 32,698 | −8% |
| What is X? | Read the whole file: 44,378 | `lsp symbols`: 14,975 | −66% |
| | | `lsp hover`: 2,027 | −95% |
| Every `new X(…)` | Grep: 6,620 (45 hits) | `ast_grep`: 7,367 (45 hits) | +11% |
| Where is X defined? | Grep `class X`: 755 | `lsp workspace_symbols`: 3,931 | +421% |

The table counts only the tool output. It does not count the Read calls that an agent often makes
after a Grep, to tell the real uses from the noise. To find where a symbol is defined, a precise
Grep is smaller: `workspace_symbols` also lists similar names. Use `lsp definition` from a use.

**Correct results.** For the 8 symbols, whole-word Grep gave 277 lines and `lsp references` gave
242 locations. The other Grep lines were test titles and other strings, JSON and Xcode project
files, and a different class with the same name from a package. `lsp references` missed 2 real
uses: they are in a script that is in no `tsconfig.json` project, so the server cannot resolve its
import.

**Speed**

| Call | Time |
| --- | ---: |
| Grep (ripgrep) | about 60 ms |
| `ast_grep` over the whole repo | about 110 ms |
| `lsp hover`, server running | 2 ms |
| `lsp references`, asked again | 139 ms |
| `lsp references`, first time for a symbol (the server loads the projects that use it) | 1.2–2.9 s |
| First `lsp` call, server start included | 3.1 s |

**Costs**

- **Context:** the two tool definitions (3,082 characters) and the prompt section (1,062
  characters) are in every request: about 4,100 characters, or about 1,000 tokens.
- **Memory:** in this repo, one TypeScript server used 2.0 GB of RAM with the projects of the 8
  symbols loaded. Code Compass 0.3.0 started one server per `tsconfig.json`: 8 servers and 4.9 GB
  for the same 8 questions, and its `references` missed most uses in other projects.
- **Time:** the first `lsp` call for a project takes seconds, Grep takes milliseconds. For a
  quick text search, Grep is still the right tool.

These numbers come from one TypeScript repo. Other languages use other servers, with their own
speed and memory.

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

A server starts on first use and stops after 10 idle minutes or when the session ends. There is
one server per project root: the nearest `go.mod`, `Cargo.toml`, `pyproject.toml`, … For
TypeScript and JavaScript it is one server for the whole workspace, because the TypeScript server
serves every `tsconfig.json` project below it. Before it answers, Code Compass waits for the
server's own start-up work (`$/progress`).

The TypeScript server finds references only in the projects it has loaded. So for `references`,
Code Compass also looks for the files that contain the name. It asks the server again from each
such file that has no known use yet. When that file uses the same declaration, the server's answer
also covers the other files of that project. A file that has the name only in a comment or a
string, or for a different symbol with the same name, adds nothing. This search stops after 40 s;
then the result says how many files it did not check.

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
