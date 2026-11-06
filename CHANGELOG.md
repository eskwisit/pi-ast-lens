# Changelog

## 0.3.2

### Fixes

- **extension:** share one typescript server across all tsconfigs (`b5cfa50`)
- **extension:** find references in every tsconfig project of a monorepo (`50e144b`)

### Documentation

- **readme:** show what code compass adds, with measured size and speed (`3a8c1b0`)

### Tests

- cover the outermost workspace root and the files that hold a name (`138bf10`)
- find references across tsconfig projects with one server (`48e4a89`)

## 0.3.0

### Features

- **extension:** read code with ast-grep and language servers, not grep (`87a058b`)
- **skills:** add the code compass skill for patterns, rules and lsp traces (`52e77d1`)
- **manifest:** declare the agent extension, skill and permissions (`f4f3b67`)

### Documentation

- **readme:** describe the tools, platforms, requirements and settings (`230fd02`)

### Tests

- cover language inference, launching, the lsp wire and grep steering (`38af3ea`)
- run the tools end to end with ast-grep, clangd and typescript (`d6322d5`)
- cover the manifest texts, license and contributed files (`e0e575c`)
- add a test entry point for node --test tests/ (`ef66cc0`)

### CI

- add the changelog notes script (`0eb3015`)
- publish a release when the manifest version changes (`56d2433`)
- run the tests on linux, macos and windows (`1d48716`)

### Chores

- ignore build output and piplug files (`6183ab7`)
- license the plugin under apache-2.0 (`d6ac71a`)
- **manifest:** start the version at 0.0.0 for the first release (`09e278c`)

### Style

- **manifest:** write the short arrays on one line (`a7c38b0`)
