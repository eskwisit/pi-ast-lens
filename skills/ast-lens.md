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
| Where a symbol is defined | `lsp` definition, with `file`, `line`, `symbol` |
| Every use of a symbol | `lsp` references |
| Its type, signature and docs | `lsp` hover |
| Implementations of an interface or abstract method | `lsp` implementation |
| The outline of one file | `lsp` symbols |
| A symbol when you only know its name | `lsp` workspace_symbols with `query` |
| Errors and warnings in a file after an edit | `lsp` diagnostics |
| Every place code has a shape (calls, imports, classes, try/catch…) | `ast_grep` with `pattern` |
| A structural search with conditions (inside, has, not) | `ast_grep` with `rule` |
| The same edit in many places | `ast_grep` with `rewrite` (preview), then `apply: true` |
| A message, comment, string, config key, doc text | Grep |

The language comes from the file extension. For a directory, `ast_grep` uses the globs or the most
common code language under it; the result header says which. Pass `lang` to choose another.

## lsp

- Point at a symbol with `line` (1-based) and `symbol` (its name on that line). Use `column` only
  when the name appears twice on the line.
- A typical trace: workspace_symbols → definition → references. Then Read only the lines returned.
- If the result says no server is installed, tell the user the install command it gives, and
  continue with `ast_grep` and Read.
- An empty result right after start usually means the server is still indexing; ask once more.

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
