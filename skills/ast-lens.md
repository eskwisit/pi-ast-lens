---
name: AST Lens
description: You need to find, trace or change code by structure — a definition, its callers, every call of an API, a code pattern to rewrite — or ast_grep / lsp results need interpreting.
---

# AST Lens

AST Lens gives you two tools that read code as code. Grep reads text: it also hits comments,
strings and look-alike names, and misses code split over lines. Use Grep only for plain text.

## Pick the tool

| You want | Call |
| --- | --- |
| Where a symbol is defined | `lsp` definition with `symbol` alone, or with `file`, `line`, `symbol` |
| Every use of a symbol | `lsp` references |
| Which functions call it | `lsp` references with `output: "functions"` |
| Its type, signature and docs (and the members of a type) | `lsp` hover |
| Implementations of an interface or abstract method | `lsp` implementation |
| The outline of one file | `lsp` symbols (`kind`, `depth` to filter) |
| The exported declarations of a folder | `lsp` symbols with the folder as `file` |
| The code of one function or class | `lsp` symbols with `symbol` and `body: true` |
| Symbols whose names you half know | `lsp` workspace_symbols with `query` |
| Errors and warnings in a file after an edit | `lsp` diagnostics |
| Every place code has a shape (calls, imports, classes, try/catch…) | `ast_grep` with `pattern` |
| A structural search with conditions (inside, has, not) | `ast_grep` with `rule` |
| Rename a function, class, method or variable everywhere | `lsp` rename with `new_name` (preview), or with `apply: true` |
| The same edit in many places | `ast_grep` with `rewrite` (preview), then `apply: true` |
| A value at run time: why a result is wrong, what a variable holds | `debug` probe with `program`, `breakpoints` and `eval` |
| Walk through the code line by line | `debug` start, then step, continue, eval, stop |
| A message, comment, string, config key, doc text | Grep |

The language comes from the file extension. For a directory, `ast_grep` uses the globs or the most
common code language under it; the result header says which. Pass `lang` to choose another.

## lsp

- Point at a symbol with `line` (1-based) and `symbol` (its name on that line). Use `column` only
  when the name appears twice on the line.
- Ask hover or symbols before you Read a file: they often answer the question.
- A typical trace: definition (by name) → references. Then Read only the lines returned.
- Every references result ends with a footer: `N verified, M unverified text matches, K files
  unchecked`. Unverified matches are the name as text in files the server could not resolve
  (a comment, a string, a file in no project): check them before a rename. With unchecked files,
  call again with `continue: true`.
- rename changes every verified use, in every project of the workspace, and lists the text matches
  it did not change (comments, strings). With a name alone and two declarations of that name, it
  asks for `file` and `line` and writes nothing. Do not rename with sed or Grep: a regex also hits
  look-alike names, and `\b` does not work in macOS sed.
- Results show at most `limit` hits (default 50) and say how many more there are. `output:
  "files"` or `"count"` gives less.
- If the result says no server is installed, tell the user the install command it gives, and
  continue with `ast_grep` and Read.
- An empty result right after start usually means the server is still indexing; ask once more.
- `experimental` in the header: the server is not tested end to end for that language. Check
  surprising answers with `ast_grep` or Grep.

## debug

- `probe` is one call: it runs `program` to the first breakpoint (`"src/cart.ts:12"`, or
  `"src/cart.ts:12 if total > 100"`), returns the stack, the locals and each `eval` expression, then
  stops the program. An uncaught exception also stops it, at the line that throws.
- Use `start` for a live session, then `step` (`over`, `in`, `out`), `continue`, `eval` and `stop`.
  Each call waits until the program stops again or ends (`timeout`, default 30 s).
- Node.js and TypeScript run under Node's own inspector (Node 23 or later runs `.ts` files as they
  are). Python needs debugpy, Go needs dlv, C/C++/Rust/Swift need lldb-dap and a debug build (`-g`).
- `eval` runs code inside the program. Do not eval code that changes data you need.

## Grep results

A Grep for an identifier comes back grouped by file. Hits in comments and strings are shown as
line numbers only (Read those lines if you need the text); `← definition` marks the declaration.

## ast_grep patterns

A pattern is valid code in the target language, with metavariables:

- `$X` matches one node (an expression, a name, an argument). The same name twice must match the
  same code: `$A == $A`.
- `$$$` matches any number of nodes: `foo($$$)` matches every call of `foo`; `$$$ARGS` names them.
- `$_` matches one node without capturing it.

Examples:

| Language | Pattern |
| --- | --- |
| TypeScript | `useEffect($FN, [])` · `await $P.catch($$$)` · `import { $$$ } from "lodash"` |
| Python | `def $F($$$): $$$` · `except Exception: $$$` · `print($$$)` |
| Go | `if err != nil { return $$$ }` · `fmt.Println($$$)` |
| Rust | `$X.unwrap()` · `impl $T for $S { $$$ }` |

A pattern that is not a complete statement may need `selector`, or a rule:

```yaml
kind: function_declaration
has:
  pattern: await $X
  stopBy: end
```

Useful rule keys: `kind`, `pattern`, `regex`, `inside`, `has`, `not`, `all`, `any`, with
`stopBy: end` to search all descendants or ancestors. A rule may also have `fix:`.

## Rewrites

1. Call `ast_grep` with `pattern` and `rewrite`. It shows each change as `-` / `+` lines.
2. Check the preview. Narrow `path` or `globs` if it touches code it should not.
3. Call again with `apply: true`, then run `lsp` diagnostics on the changed files.
