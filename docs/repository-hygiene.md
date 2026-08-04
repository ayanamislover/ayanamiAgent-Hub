# Repository hygiene

This repository separates durable product assets from local runtime state and disposable evidence.
The distinction is enforced by `pnpm hygiene`; it is also part of the root `pnpm lint` gate.

## Asset classes

| Class                          | Examples                                                                                    | Git                    | Lifecycle                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------------------- |
| Product source and contracts   | `apps/`, `packages/`, `migrations/`, tests                                                  | tracked                | changed only through a scoped task and review                   |
| Durable documentation          | `README.md`, `docs/`, incident reports                                                      | tracked                | describes current contracts or an explicitly dated event        |
| Historical records             | completed plans and dated smoke records below `docs/history/`                               | tracked                | retained as history; never presented as current state           |
| Project identity               | `.crossagent/project.json`                                                                  | ignored                | persistent; never removed by repository cleanup                 |
| User runtime data              | `~/.crossagent/token`, database, Hub/Bridge logs                                            | outside the repository | persistent; cleanup scripts never inspect or remove it          |
| Active build/install output    | `dist/`, `node_modules/`                                                                    | ignored                | reproducible, but retained while Hub or Bridge processes use it |
| Disposable verification output | `output/`, `.playwright-cli/`, `coverage/`, `.vite/`, `playwright-report/`, `test-results/` | ignored                | may be removed after evidence is recorded in a task or review   |

One-off incident reports belong in `docs/incidents/`, not the repository root. A report may name an
ignored screenshot or log as transient evidence, but the durable proof must be a command result,
test, commit, immutable artifact, or reproducible procedure.

## Commands

```powershell
# Fails on tracked generated/log/database artifacts, no-op package gates,
# unused direct runtime dependencies, unconsumed libraries, >50 work-log entries,
# a credential written into a URL in tracked Markdown, a local machine path in a
# tracked text file, or a relative Markdown link that no longer resolves.
pnpm hygiene

# Dry-run: prints exact directories, file counts, and bytes.
pnpm clean:artifacts:check

# Deletes only the allowlisted disposable verification directories.
pnpm clean:artifacts
```

The cleanup command discovers the repository and workspace roots itself, rejects symbolic-link
targets, verifies every target remains below the repository root, and deliberately excludes
`.crossagent`, `dist`, and `node_modules`.

## Deletion test

A module or test is not deleted just because it is small or old. Delete it only when all of the
following are true:

1. no caller crosses its interface;
2. it protects no unique invariant or regression;
3. its implementation is either reproducible or no longer part of the product;
4. deleting it does not scatter its complexity across other modules.

Dependencies in `dependencies` must be imported by repository code in the same workspace. Tooling
that is invoked only from package scripts belongs in `devDependencies` and is not subject to that
runtime import check. A private library Module below `packages/` must have a caller or an executable
Interface; an unconsumed placeholder is not a future-proof Seam.

Do not use broad `git clean -X`, `git gc`, or `git prune` as cleanup. Ignored project identity is
valuable, and a pending immutable review may depend on a zero-reference Git object.
