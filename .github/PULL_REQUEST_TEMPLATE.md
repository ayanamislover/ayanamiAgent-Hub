<!--
Read CONTRIBUTING.md first if you have not. The two rules that get a change rejected on sight:
a static bootstrap credential is never a data-plane fallback, and a check is never weakened to
make CI green.
-->

## What changed and why

<!-- What was wrong, why it was wrong, and what this does about it. The commit body should already
say this; a sentence here is enough if it does. -->

## How it was verified

<!-- Which command, which case, on which platform. "CI is green" is not verification of a
behaviour change — name the test that fails without this patch, or say plainly that there is none
and why. -->

## Checklist

- [ ] `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm build` and `pnpm test` all pass
      locally
- [ ] A behaviour change brings a test that fails without it
- [ ] No credential, session ticket or database content appears in the diff, the tests or this
      description
- [ ] No local machine path in a tracked file (repository hygiene refuses these)
- [ ] Documentation updated if a command, a wire shape or a credential path changed
- [ ] `migrations/` was only appended to, never edited in place
