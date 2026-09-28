# Contributing to Kizlo Kit

## Prerequisites

- Node matching `.nvmrc` (`nvm use`)
- pnpm 9.6+

## Getting started

```bash
pnpm install
pnpm build
```

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
- **Server-first.** Fetch in a server component and pass the payload down. The client half writes the URL and reads
  context; it does not fetch.
- **One hook per component.** A single provider value means every consumer re-renders together anyway, so per-slice hooks
  would only be naming sugar.
- **Fail soft.** A dead request degrades the component, it does not blank the page.

## Code style

[Biome](https://biomejs.org/) handles linting and formatting (`biome.json`): tabs, double quotes, semicolons only where
needed. Run `pnpm check:fix` before committing. CI runs `biome ci .` and fails on anything unformatted.

- Match the surrounding code. Keep comments for *why*, not for restating *what*.
- Types come from the integration package (`@kizlo/woocommerce`), never from an app's generated client.
- A component takes the Kizlo client as a prop or from context. A package must never import an app's client singleton,
  because that client is generated per app.

## Core and adapters

A package is a framework-agnostic core plus one thin adapter per framework. The core sits at the root of `src`, because it
is the package; an adapter is a subdirectory, because it is a binding.

```
src/*.ts       no React, no URL-state library, no JSX. The contract, the requests, the model, the client contract.
src/react/     the adapter: hooks in, one write callback out.
src/<other>/   the next adapter, built on the same core.
```

The core is the component minus the rendering. If logic can be written without knowing what renders it, it belongs there,
and "it is easier with hooks" is not an exception. An adapter that is more than a thin binding means something is in the
wrong place.

Entry points follow the layout: `.` is the core, `./react` is the client-side binding, `./react/server` is the server
component. Add them to `tsdown.config.ts`, the `exports` map and `tooling/typescript/base.json` together.

Two rules that are easy to break:

- **A framework is an optional peer dependency.** A Solid app installing the package must not be told React is missing.
- **Any entry reachable from client code needs `"use client"` on its built chunk.** The bundler drops the source
  directive, so `tsdown.config.ts` re-adds it by chunk name. A server entry importing a provider chunk without it turns
  that provider into a server component, which fails at the first hook.

### One grammar, two implementations

The URL contract lives in `contract.ts` as plain parse and serialize functions. The React adapter also expresses it
as nuqs parsers, because that is what buys `shallow: false` writes and transitions. Two encodings of one grammar is a
drift risk, so `react/params.test.ts` asserts they agree on every URL a shopper can produce. It has already caught one
divergence: `URLSearchParams` percent-encodes the colon in `pa_color:blue` and nuqs does not. Any new parameter needs a
case there.

## Versioning

The packages are public and on 0.x. Until a 1.0, a minor may break the component API, and the changelog says so when it
does. What does not get to move casually is the URL contract: those tokens end up in shared links, sitemaps and campaigns,
so treat a change to one as breaking regardless of the version number it lands in.

## Changesets

Published packages are versioned with [Changesets](https://github.com/changesets/changesets). If your change affects a
package, add one:

```bash
pnpm changeset
```

Pick the affected packages and a standard 0.x semver bump, then commit the generated file alongside your change. Give it
**one line**: a single imperative sentence describing the user-visible effect. No essays, no internals, no bullet lists.

Changes that only touch tooling, tests or docs need no changeset.

## Commit messages and pull requests

- [Conventional Commits](https://www.conventionalcommits.org/) for subjects (`feat:`, `fix:`, `chore:`, `docs:`).
- Scopes follow the code, using the integration's own name rather than the package's: `woocommerce` and `cf7` for the
  kits, `kit` for the core, `ci` for workflows. Omit the scope rather
  than inventing one.
- The PR title must match the commit subject. `.github/workflows/pr.yaml` validates it.
- Write the PR body under these headings, in order: **Why** (the problem), **What changed** (the resulting behaviour and
  the shape of the approach), **Notes** (deliberate scope calls, trade-offs, risks), **Verified** (the checks you ran and
  their result, including anything skipped). A few lines each; drop any that would be empty.
- Keep every PR to a single commit. Amend and re-push with `--force-with-lease` as the change evolves. We squash-merge
  from the branch's commit messages, so one commit keeps that message clean. The commit body is the summary of what the
  PR ends up doing, not the PR description.
- These are the checks CI runs. Make them pass locally first:

  ```bash
  pnpm check
  pnpm typecheck
  pnpm build
  pnpm test
  ```

- Open pull requests as drafts and keep them not review-ready until the checks pass and a maintainer says to mark them
  ready.

## License

By contributing, you agree that your contributions will be licensed under the [Apache License 2.0](./LICENSE).
