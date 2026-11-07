# AST Lens for PI-Desktop

AST Lens makes PI-Desktop's agent read code as code, not as text. It finds definitions, callers and symbol bodies in milliseconds. It renames a symbol across the whole project in one call. It stops a program at a breakpoint and shows the real values. The agent reads up to 13× less text, uses fewer tokens and gives more correct answers.

## Benchmark: pi vs pi with AST Lens

TypeScript monorepo: 343 files, 31 `tsconfig.json` projects. AST Lens uses tsgo (TypeScript 7). Tokens are characters ÷ 4, so the token savings equal the character savings.

| Question | pi (Grep, Read, Bash) | pi with AST Lens | Savings |
| --- | --- | --- | --- |
| Where is this function defined? | 2,323 chars · 581 tokens · 10 ms | **565 chars · 141 tokens · 5 ms** | **−76% tokens · −50% time** |
| What does this file contain? | 5,701 chars · 1,425 tokens · 8 ms | **585 chars · 146 tokens · 1 ms** | **−90% tokens · −88% time** |
| Show me this one method | 5,701 chars · 1,425 tokens · 8 ms | **442 chars · 111 tokens · 1 ms** | **−92% tokens · −88% time** |
| What is the type of this symbol? | 5,701 chars · 1,425 tokens · 8 ms | **337 chars · 84 tokens · 3 ms** | **−94% tokens · −63% time** |
| Which functions call this function? | 6,235 chars · 1,559 tokens | **920 chars · 230 tokens** | **−85% tokens** |
| Rename a function: 33 uses in 7 files | 1.3 s · nothing renamed | **23 ms · all 33 renamed** | **−98% time · correct** |

Two agent teams did the same 8 tasks with the same model:

| | pi | pi with AST Lens | Savings |
| --- | --- | --- | --- |
| Correct answers | 6 of 8 | **8 of 8** | **+2 correct answers** |
| Text read | 51,839 chars · 12,960 tokens | **20,146 chars · 5,037 tokens** | **−61% tokens** |

pi got 2 tasks wrong. It named the wrong caller, because Grep shows a line, not the function around it. Its `sed` rename changed nothing, but it reported success.

## Tools

### `lsp`

Answers from an AST index of the project, and from the language server for type questions.

| Operation | Gives |
| --- | --- |
| `definition` | Where a symbol is declared. A name alone is enough. |
| `references` | Every real use, the function around each use, and what it could not check. |
| `rename` | Every verified use, in every project. Preview first; `apply: true` writes. |
| `hover` | Type, signature, docs and members. |
| `symbols` | The outline of a file, the exports of a folder, or one symbol's code (`body: true`). |
| `workspace_symbols` | Symbols that match a name. |
| `implementation`, `type_definition` | Where an interface is implemented, or a type is declared. |
| `diagnostics` | Errors and warnings in a file after an edit. |

### `ast_grep`

Finds code by its shape: `fetch($URL, $$$)` finds every call of `fetch`. It never matches comments or strings. Add `rewrite` to change all matches; `apply: true` writes the change.

### `debug`

Runs a program to a breakpoint and shows the stack, the local variables and expressions you ask for.

- `probe`: one call. It runs to the breakpoint, answers, and stops the program.
- `start`, `step`, `continue`, `eval`, `stop`: a live session.
- A breakpoint can have a condition: `"src/cart.ts:12 if total > 100"`.
- An uncaught exception stops the program at the line that throws.

Node.js and TypeScript need nothing more. Python uses debugpy, Go uses dlv, C, C++, Rust and Swift use lldb-dap.

### Grep results

A Grep for a name in code comes back grouped by file. Hits in comments and strings show as line numbers only. Grep is never blocked.

## Speed

- At start, AST Lens outlines the whole project with ast-grep: 60 ms for 440 files.
- Definitions, outlines and symbol bodies come from this outline. No language server is needed.
- For TypeScript, AST Lens uses tsgo when you have it: `npm i -g @typescript/native-preview`.
- With tsgo, the first `references` call takes 110–170 ms. Later calls take about 20 ms.

## Settings

`/ast-lens` shows the tools and language servers it found. `/ast-lens mode off` turns off the Grep changes and the prompt section.

The settings file is `ast-lens/config.json` in `~/.config`, or in `%APPDATA%` on Windows:

```json
{
	"mode": "steer",
	"prewarm": true,
	"maxRssMb": 3000,
	"servers": { "py": ["ruff", "server"] }
}
```

- `prewarm: false`: do not start the language server when the agent starts.
- `maxRssMb`: stop a language server that uses more memory than this.
- `servers`: use your own language server for a file extension.

## Install

Download `eskwisit.ast-lens-<version>.piplug` from the [releases](https://github.com/eskwisit/pi-ast-lens/releases). Open it from the PI-Desktop plugins page. Requires PI-Desktop 0.21 or later.

## Development

```sh
node --test tests/*.test.mjs
node tests/bench/run.mjs --gate
```

## License

Apache-2.0
