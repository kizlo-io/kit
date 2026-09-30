# Contributing to Kizlo Kit

Thanks for your interest in contributing. This guide covers setting the project up, the day-to-day workflow, and what a
pull request is expected to carry.

## Scope

This guide governs the whole repository and is the authoritative source for setup, implementation, verification,
version-control, pull-request, and merge decisions. Unless a command says otherwise, run it from the repository root,
where the Turborepo scripts fan out across every package.

There is no `AGENTS.md` and no nested `CONTRIBUTING.md` today. If a subdirectory gains either, that nested guide wins
inside its own subtree and this one still covers whatever the nested guide leaves unsaid.

This repository is deliberately separate from the [kizlo monorepo](https://github.com/kizlo-io/kizlo): the kits release on
their own cadence and need no WordPress stack. Do not import that repo's setup, test, or release steps — they do not apply
here.

## Code of Conduct

This project is governed by the Kizlo
[Code of Conduct](https://github.com/kizlo-io/.github/blob/main/CODE_OF_CONDUCT.md). By participating, you are expected to
uphold it.

## Prerequisites

- **Node** — `.nvmrc` pins 24.16.0 (`nvm use`); the minimum is 22.14
- **pnpm** — `corepack enable` provides the pinned version (11.2.2); the minimum is 9.6

That is the whole list. There is no Docker, no PHP, no WordPress, no database, and no `.env` — nothing here talks to a
running WordPress. A kit is tested against its own fixtures, and the integration types come from `@kizlo/woocommerce` as a
dev dependency. If you find yourself needing a service to run a test, the test is reaching too far.

## Getting started

```bash
git clone https://github.com/kizlo-io/kit.git
cd kit
corepack enable             # provides the pinned pnpm version
pnpm install
pnpm build
```

Your environment is ready when this passes:

```bash
pnpm build && pnpm test
```

Nothing starts a background service, so there is nothing to tear down afterwards. `pnpm clean` removes build output and
`node_modules` if you want a genuinely fresh start.

## Repository layout

```
packages/   Published npm packages, one per integration (@kizlo/kit, @kizlo/*-kit)
tooling/    Internal config: TypeScript bases, the composite GitHub Action
scripts/    Repository maintenance scripts
```

This is a [Turborepo](https://turbo.build/) + pnpm workspace.

## Common commands

```bash
pnpm build        # build every package
pnpm dev          # watch + rebuild while developing
pnpm typecheck    # type-check the workspace
pnpm check        # lint + format check (Biome)
pnpm check:fix    # auto-fix lint + format issues
pnpm lint:ws      # check the workspace for dependency mismatches (Sherif)
pnpm test         # run the unit tests
pnpm test:only    # test one package, e.g. pnpm test:only @kizlo/woocommerce-kit
pnpm test:watch   # Vitest in watch mode
```

Turbo builds whatever a task depends on first, so there is no manual build step before `typecheck` or `test`.

## Bones and skin

The split is the architecture, and it is not negotiable.

**Bones ship as packages.** A kit wraps one integration and ships behaviour: the URL contract, the requests, the derived
model, the pending state. It renders `children` and nothing else.

**Skin ships as code.** Anything that has to look a certain way is handed to the user through the shadcn registry, so they
own the file and edit it freely. Styling is the part everyone changes, which makes a version bump the wrong delivery
mechanism for it.

A package therefore never contains markup, class names, a styling dependency, or a design decision. If a review question is
"how should this look", the answer is that it does not belong in `packages/`.

A new kit is named after the integration it wraps, with `-kit` appended: `@kizlo/woocommerce` is wrapped by
`@kizlo/woocommerce-kit`, `@kizlo/cf7` by `@kizlo/cf7-kit`. `@kizlo/kit` is the core and takes no prefix, because it wraps
nothing. The directory matches the package name.

Before adding a component, check it against these:

- **Headless.** Render `children` and expose state through a hook. No Tailwind classes, no design decisions, no `div` you
  did not need.
- **Fetch where the data lives.** Page data is server-rendered: an RSC reads the URL, loads the payload and passes it
  down, and the client half re-runs that component with a `shallow: false` URL write rather than fetching itself — the
  product collection. Browser-session and ephemeral state has no page to hang off, so it is fetched in the client through
  an optional query-library peer — the cart, the search typeahead. Both shapes are still headless and still fail soft.
- **One hook per subject.** One provider value means every consumer re-renders together anyway, so slicing it into several
  hooks is only naming sugar. A feature whose hooks address different things — the cart, one of its lines, its coupons —
  gets one per thing, because a per-entity hook takes the key and does the lookup its consumer would otherwise repeat.
- **Fail soft.** A dead request degrades the component, it does not blank the page.

### Providers

A provider carries **app configuration** — one per kit, mounted by the app — or **server data**, page-scoped and mounted
by the RSC that loaded it. Feature state never gets one: a hook reads the client, the kit's configuration and the app's
cache, so adding a feature to a storefront mounts nothing new.

The Kizlo client reaches client components through `KizloProvider` (`kizlo/react`) and server components as a prop,
because a server component cannot read React context. The browser client and the server client are different instances,
so neither half may hold the other's. A hook never takes a client: one client per app is what the provider is for.

The app owns `QueryClientProvider`. No kit creates a `QueryClient` or sets global react-query defaults: one cache per app
is what lets a checkout seed the cart's own cache entry instead of racing a second copy of it.

## Code style

[Biome](https://biomejs.org/) handles linting and formatting (`biome.json`): tabs, double quotes, semicolons only where
needed. Run `pnpm check:fix` before committing. CI runs `biome ci .` and fails on anything unformatted.

- Match the surrounding code. Keep comments for *why*, not for restating *what*.
- Types come from the integration package (`@kizlo/woocommerce`), never from an app's generated client. The client itself is
  typed by `ActiveKizloClient` from `kizlo`, which each app resolves from the procedures it registered — a kit never restates
  the shape of a client it calls. `packages/woocommerce-kit/types/registry.ts` registers the WooCommerce contract so this
  repo's own `pnpm typecheck` resolves those calls exactly; it is deliberately outside `src/` and outside the build tsconfig.
- A component takes the Kizlo client as a prop or from context. A package must never import an app's client singleton,
  because that client is generated per app.

### No tool attribution

Nothing in this repository carries AI or tool attribution. No `Co-Authored-By` trailer naming a tool, no "generated with"
line, no "authored by" note — in commit messages, PR titles and bodies, changesets, code comments, or docs. The commit
author is the contributor.

### Files you do not hand-edit

Two kinds of file are written for you:

- `packages/*/CHANGELOG.md` — compiled by Changesets at release time from the files in `.changeset/`.
- `pnpm-lock.yaml` — updated by pnpm. Commit the change it makes; never edit it.

There is no code generator in this repository. The entry-point triple below is a manual sync rule, not a generated
artifact, which is exactly why it is easy to half-do.

## Core and adapters

A package is a framework-agnostic core plus one thin adapter per framework. The core sits at the root of `src`, because it
is the package; an adapter is a subdirectory, because it is a binding.

```
src/*.ts       no React, no URL-state library, no JSX. The contract, the requests, the model.
src/react/     the adapter: hooks in, one write callback out. It may own a data client.
src/<other>/   the next adapter, built on the same core.
```

The core is the component minus the rendering. If logic can be written without knowing what renders it, it belongs there,
and "it is easier with hooks" is not an exception. An adapter that is more than a thin binding means something is in the
wrong place.

A client-data feature gets its own `src/react/<feature>.tsx` entry instead of joining `react/client.tsx`, because its
query library would otherwise be resolved by a consumer that only uses the page-data half.

Entry points follow that split:

| Entry | Holds | Peers |
| -- | -- | -- |
| `kizlo/react` (upstream, not this repo) | `KizloProvider`, `useKizloContext` | react |
| `@kizlo/<integration>-kit/react/provider` | the kit's one configuration provider | react |
| `@kizlo/<integration>-kit/react` | page-scoped, URL-driven features | react, nuqs |
| `@kizlo/<integration>-kit/react/<feature>` | client-data features | react, a query library |

`.` is the core and `./react/server` is the server component. Add every new entry to `tsdown.config.ts`, the `exports`
map and `tooling/typescript/base.json` together.

Two rules that are easy to break:

- **A framework is an optional peer dependency.** A Solid app installing the package must not be told React is missing.
  `react`, `nuqs` and `@tanstack/react-query` are all carried this way: `peerDependencies` plus
  `peerDependenciesMeta.optional`, and `devDependencies` from the catalog.
- **Bound 0.x peers to the verified minor.** Use a caret range, and update the catalog dependency, peer range and
  changeset together when support moves to another minor. A peer at 1.0 or later may keep an open-ended minimum when the
  kit deliberately expects future majors to remain compatible. The peer warning is the guard; do not enable
  `strict-peer-dependencies` to turn it into an installation failure.
- **Any entry reachable from client code needs `"use client"` on its built chunk.** The bundler drops the source
  directive, so `tsdown.config.ts` re-adds it to every chunk one of the package's client modules lands in — listed by
  module, not matched on the chunk name, because a name is emergent: it can miss a new entry and it misses the shared
  chunk two entries split. A server entry importing a provider chunk without the directive turns that provider into a
  server component, which fails at the first hook.

### One grammar, two implementations

The URL contract lives in `contract.ts` as plain parse and serialize functions. The React adapter also expresses it
as nuqs parsers, because that is what buys `shallow: false` writes and transitions. Two encodings of one grammar is a
drift risk, so `react/params.test.ts` asserts they agree on every URL a shopper can produce. It has already caught one
divergence: `URLSearchParams` percent-encodes the colon in `pa_color:blue` and nuqs does not. Any new parameter needs a
case there.

## Documentation

A change to a public API or to user-visible behaviour updates the affected package's `README.md` in the same pull request.
Adding a package also adds its row to the root `README.md` table. If neither applies, say so in the PR's **Notes** and
why.

## Tests

[Vitest](https://vitest.dev/) only. Each package owns a `vitest.config.ts` and Turbo runs them; the root config exists for
`pnpm test:watch` alone. Tests are colocated with the code they cover as `<name>.test.ts` next to `<name>.ts`.

```bash
pnpm test                                   # every package
pnpm test:only @kizlo/woocommerce-kit       # one package
pnpm test:watch                             # watch mode across the workspace
```

Tests run against `src`, not `dist`, and need no fixtures, services, or cleanup. Packages run with
`--passWithNoTests`, so a package without tests is not a failure.

What must carry a test:

- **Any new or changed URL parameter** — a case in that package's `react/params.test.ts`, covering both encodings. This is
  the one non-negotiable: the two implementations have diverged before.
- **Contract parse and serialize changes** — the round-trip, plus whatever malformed input you decided to tolerate.
- **Derived model changes** — the derivation, from a fixture payload.

There is no coverage threshold. A request wrapper that only forwards arguments does not need a test proving it forwards
arguments.

## Verification

Run the narrowest thing first — `pnpm test:only <package>` while you work. Before opening a pull request, run the full
gate, in this order, because it is the order CI uses:

```bash
pnpm check
pnpm typecheck
pnpm build
pnpm test
```

All four must pass locally. Record the result in the PR's **Verified** section. If a check could not run, name it and say
why rather than leaving it out — an absent check reads as a passing one.

## Versioning

The packages are public and on 0.x. Until a 1.0, a minor may break the component API, and the changelog says so when it
does. What does not get to move casually is the URL contract: those tokens end up in shared links, sitemaps and campaigns,
so treat a change to one as breaking regardless of the version number it lands in.

## Changesets

Published packages are versioned with [Changesets](https://github.com/changesets/changesets). **If your change affects
anything a consumer of a `packages/*` package can observe, add one:**

```bash
pnpm changeset
```

Pick the affected packages and a standard 0.x semver bump, then commit the generated file alongside your change. Give it
**one line**: a single imperative sentence describing the user-visible effect. No essays, no internals, no bullet lists.

Changes confined to `tooling/`, `scripts/`, `.github/`, tests, or docs need no changeset. Changesets ignores `@tooling/*`
outright (`.changeset/config.json`), so adding one for those packages does nothing.

## Tracked issues

Issues are tracked in Linear, in the **Kit** team, with `KIT` keys. A tracked issue is the source of truth for the work:
its description carries the context, plan, completion criteria, tests, and verification, and the pull request does not
restate them.

The **branch name is what links the pull request back to the issue** — Linear's GitHub integration matches on it. Do not
put the issue key in the PR title, the commit subject, or the commit body.

## Branch names

```
<type>/<short-slug>
```

The type is the same Conventional Commit type the PR title will use. Keep the slug to three or four lowercase hyphenated
words naming the change, not the symptom:

```
fix/derive-list-parameters
feat/collection-facets
```

Working from a tracked issue, insert the lowercased issue key after the type:

```
feat/kit-12-collection-facets
```

Cut every branch from a clean tree and a freshly pulled `main` (`git status` clean, then `git checkout main && git pull`).
Branching on top of uncommitted work or a stale `main` is what produces avoidable conflicts later. Publish branches to
`origin`.

Never commit directly to `main`.

### Worktrees for tracked-issue automation

Working by hand in a clean primary checkout is fine. Automation running a tracked issue instead cuts an isolated worktree
at `.worktrees/<issue-key>` from current `origin/main`, so the primary checkout and any unrelated local changes stay
untouched:

```bash
git fetch origin main
git worktree add -b <type>/<issue-key>-<slug> .worktrees/<issue-key> origin/main
```

A fresh worktree needs nothing copied into it. There is no `.env` and no local state here, so `pnpm install` is the only
step between a new worktree and a working build — the opposite of the kizlo monorepo, where the root `.env` has to be
carried across.

`pnpm worktree:sweep` removes worktrees whose pull request has merged, along with their local and remote branches. It
keeps anything with uncommitted changes, unpushed commits, or an open PR, and honours a 24-hour grace period after the
merge (`--dry-run` to preview, `--grace-hours <n>` to change it). It needs the `gh` CLI authenticated.

Never nest one worktree inside another, and never reuse one issue's worktree for a different issue. The ignored locations
are in `.gitignore`; a worktree must never be committed.

## Commit messages and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) for subjects (`feat:`, `fix:`, `chore:`, `docs:`,
  `refactor:`, `perf:`, `test:`, `ci:`, `build:`, `style:`, `revert:`).
- Scopes follow the code, using the integration's own name rather than the package's: `woocommerce` and `cf7` for the
  kits, `kit` for the core, `ci` for workflows. Omit the scope rather than inventing one.
- The PR title must match the commit subject, and carries no issue key and no draft marker.
  `.github/workflows/pr.yaml` validates it and fails the PR otherwise.
- Keep PRs focused; describe what changed and why.
- Write the PR body under these headings, in order: **Why** (the problem), **What changed** (the resulting behaviour and
  the shape of the approach), **Notes** (deliberate scope calls, trade-offs, risks), **Verified** (the checks you ran and
  their result, including anything skipped or not applicable). A few lines each; drop any that would be empty.
- Write it for a reviewer assessing the change, not as a log of the steps you took.
- Keep the description current as the diff and checks evolve. **Verified** must match the checks that actually ran and
  their latest result, and the other sections must still describe the PR as it now stands.
- Reference an issue with `Closes #123` only when a GitHub issue actually exists. A Linear issue is linked by the branch
  name instead, so leave the issue line out.
- No labels, reviewers, milestones, or ownership routing are required. There is no PR template to preserve.
- No screenshots, recordings, or browser checks are expected. The packages render nothing, so there is nothing to
  show; if a change is only observable in a consuming app, describe the scenario you ran under **Verified**.
- Open every pull request as a **draft**, and keep it not review-ready until the full gate in [Verification](#verification)
  passes and a maintainer explicitly says to mark it ready. Feedback on a draft is not that sign-off.
- Resolve a review thread only once its concern is actually addressed or answered, not to clear the list.
- Maintainers merge. After review approval a maintainer squash-merges; the single-commit rule below is what keeps that
  squash message clean.

## Keeping one commit per PR

We squash-merge, and the repository is set so the squash commit message is built from the branch's commit messages
(GitHub's `COMMIT_MESSAGES` mode). To make that box deterministic, **keep every PR as a single commit**:

- The branch carries exactly one commit. As the change evolves, amend it (`git commit --amend`) and re-push with
  `git push --force-with-lease`. Never stack incremental commits on a PR branch.
- That commit's **body is the PR's overall-change summary** — what the code does as a result, in a few short lines, not a
  log of steps taken. Keep it current so it always describes what the PR ends up doing.
- With one commit, GitHub prefills the squash modal from it: the subject is the Conventional Commit subject (which equals
  the PR title) and the extended description is that commit body. At merge the reviewer checks the diff and clicks
  "Squash and merge" with both fields already right.

Do not put the PR description into the commit body — it is written for reviewers and is too long for history. Do not leave
more than one commit: the squash box then collapses to a bulleted list of commit subjects and loses the summary.

Rewriting history is limited to your own single-commit PR branch, and always with `--force-with-lease`. When a branch is
shared, meaning someone else has commits on it or is reviewing from it, do not rewrite its history without coordinating
first.

## Reporting bugs

Open an issue at https://github.com/kizlo-io/kit/issues with a clear description and, where possible, a minimal
reproduction.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
