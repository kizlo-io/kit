---
name: extract-to-kit
description: Extract behaviour from any consuming app into a Kizlo Kit package (@kizlo/woocommerce-kit and friends). Use when asked to extract, move, promote or pull a component, hook or piece of app logic out of a project and into a kit package, or to review an extraction already in progress.
---

# Extracting into a kit package

Destination is always this repo: `packages/<integration>-kit/src/`. The source is whatever app the
request names.

Nothing moves wholesale. An app component is behaviour welded to presentation; the extraction is a
**cut**, and the package only ever gets the behaviour side. Read `CONTRIBUTING.md` — "Bones and skin"
and "Core and adapters" are the rules this skill applies, not a summary of them.

## Establish source and destination

Before reading any code, pin down three things:

1. **The source app.** A path or a repo name in the request. If it is ambiguous, ask — do not guess
   from whatever sibling checkout happens to be on disk. Find the feature by name rather than
   assuming a layout: app conventions differ (`src/components/`, `app/`, `features/`, `lib/`).
2. **The integration.** The kit is named after the integration it wraps, so the WooCommerce Store API
   goes to `@kizlo/woocommerce-kit`, Contact Form 7 to `@kizlo/cf7-kit`, anything integration-agnostic
   to `@kizlo/kit`. If the target package does not exist yet, create it following the naming and
   layout rules in `CONTRIBUTING.md`.
3. **The framework.** The core is framework-agnostic and the adapter is not. React lives in
   `src/react/`; another framework is a sibling directory built on the same core, never a fork of it.

The source app does not have to be a Next.js app, a Tailwind app, or a public repo. Only the parts that
call the store need it to be a Kizlo consumer; a pure URL grammar or a pure derivation extracts with no
client in sight.

## The cut

| Leaves the app | Stays in the app |
|---|---|
| URL parsing and serialising | Every style token: classes, styled components, CSS modules |
| Store requests and their failure handling | Design-system imports, image components, icons |
| Derived shape: groups, counts, options, labels-as-data | Layout, copy, ordering decisions that are taste |
| Pending state, the write callback | Routing, metadata, framework page conventions |

If a question about the code is "how should this look", the answer is it does not move. A package file
with a `className` in it is a failed extraction.

## Where each piece lands

A **page-data** feature is server-rendered and re-fetched by a `shallow: false` URL write — the product
collection. It lands like this:

```
src/contract.ts      URL grammar: parse, serialize, the shared vocabulary and defaults. No framework.
src/request.ts       The store calls, built from one shared input, dispatched together, failing soft.
src/model.ts         Pure derivation: responses + query + a `write` callback in, the model out.
src/react/client.tsx "use client". Context, hooks, URL writers, `useTransition`. Adapter only.
src/react/server.tsx The RSC: parse, load, provide. Takes the client as a prop.
src/react/params.ts  The same grammar as nuqs parsers, mirroring contract.ts.
```

A **client-data** feature is browser-session or ephemeral state with no page to hang off — a cart, a
typeahead. It has no RSC half and usually no URL grammar, and fetches in the browser through an
optional query-library peer:

```
src/<feature>.ts        The client slice, the cache identity, the event vocabulary, the pure
                        derivations. No framework and no query library.
src/react/<feature>.tsx "use client". The hooks, running on the app's query client. Its own entry
                        point, so a consumer of the other half never resolves the query library.
```

The core is the component minus the rendering. "It is easier with hooks" is not grounds for putting
logic in an adapter directory. An adapter holds the binding and, for a client-data feature, the query
that drives it; anything more than that landed wrong.

**Providers.** A provider carries app configuration — one per kit, mounted by the app — or server
data, page-scoped and mounted by the RSC. Feature state never gets one, so a new feature adds hooks
and no new mount. The Kizlo client reaches client components through `KizloProvider`
(`kizlo/react`) and server components as a prop, because a server component cannot read React
context. The app owns `QueryClientProvider`; no kit creates a `QueryClient` or sets global react-query
defaults.

## Procedure

1. **Read the source component and its consumers first.** Grep the app for the component and hook
   names. The consumers tell you what the API has to be; the component tells you what the behaviour
   is.
2. **Name the URL tokens** before writing anything else, if the feature has URL state. They are
   public API forever — see the versioning note below.
3. **Write the core bottom-up**: page data goes `contract.ts` → `request.ts` → `model.ts`; client
   data goes into the feature's own `src/<feature>.ts`. Each file must typecheck with no framework in
   scope.
4. **Write the adapter.** For React, a page-data feature gets `react/client.tsx` with `"use client"`
   and the hook plus `react/server.tsx` with the async component; a client-data feature gets a single
   `react/<feature>.tsx` with `"use client"` and its hooks. Anything both halves need at runtime sits
   in the core, because a `"use client"` module imported by a server component becomes a client
   reference.
5. **Register a new entry point in three places at once**: `tsdown.config.ts`, the `exports` map in
   `package.json`, and `tooling/typescript/base.json`. Missing one fails late and confusingly.
6. **Export from `src/index.ts`**, and re-export the model's *types* from the adapter's client module
   so a consumer gets the hook and its types from one specifier.
7. **Rewrite the source component** against the package: delete the moved logic, import the hook, keep
   every style token. It should get visibly shorter and read as markup plus one hook call.
8. **Write the docs in the same change.** A doc comment at the top of each new module saying *why*,
   JSDoc on every public prop, and a README section with a real page and a real consumer. The README
   is the package's only interface for someone who never reads its source.
9. **Changeset**, one imperative line: `pnpm changeset`.

## Traps

- **Never import the app's client, and never restate its shape.** A client component reads it from
  `KizloProvider` through `useKizloContext()`; a server component takes it as a prop, because it cannot
  read context. Both are typed `ActiveKizloClient` from `kizlo`, which each app resolves from the
  procedures it registered — so a feature declares no client type of its own and a hook takes no client.
- **Types come from the integration package** (`@kizlo/woocommerce`, `@kizlo/cf7`), never from the
  app's generated client directory.
- **The framework is an optional peer.** `react`, `nuqs`, `@tanstack/react-query` and their
  equivalents go in `peerDependencies` + `peerDependenciesMeta.optional`, and in `devDependencies`
  from the catalog.
- **The app owns the `QueryClient`.** A client-data feature uses the app's, through the query library
  as a peer. A package that creates its own, or sets global defaults, splits the cache and stops a
  checkout from seeding the cart entry.
- **`"use client"` is re-added by chunk name** in `tsdown.config.ts` — the bundler drops the source
  directive. A new client-side entry that does not match the banner predicate ships without it.
- **Two encodings of one grammar drift.** Any new URL parameter needs a case in the adapter's
  `params.test.ts`, which asserts `contract.ts` and the nuqs parsers agree. Percent-encoding is where
  they diverge.
- **Do not generalise for absent callers.** An option for a use case nobody has is dead weight.
  Specialise for the app you are extracting from; widening later is cheap.
- **Fail soft.** A dead request degrades the component and sets a flag; it does not blank the page or
  throw into the RSC boundary.

## Versioning

0.x, so a minor may break the component API and the changelog says so. The URL tokens do not get that
latitude: they land in shared links, sitemaps and campaigns, so changing one is breaking regardless of
the number it ships under.

## Finish gate

From this repo's root, all four:

```bash
pnpm check:fix && pnpm check
pnpm typecheck
pnpm build
pnpm test
```

Then confirm the rewritten consumer still compiles in the source app. The app installs the published
version, so point it at this workspace to try an unpublished build, run the app's own typecheck and
build, and revert the dependency change before committing:

```bash
# in this repo
pnpm build

# in the source app — pnpm shown; npm and yarn use `file:` for the same thing
pnpm add @kizlo/woocommerce-kit@link:<relative-path-to>/kit/packages/woocommerce-kit
# then the app's own checks, whatever they are
```

Never commit the link. If the app cannot be built locally, say so plainly rather than reporting the
extraction as verified.

Commit in this repo as one conventional commit scoped to the integration, not the package:
`feat(woocommerce): ...`. Branch naming, the single-commit rule and the pull-request contract are in
`CONTRIBUTING.md`. Then state plainly what moved, what deliberately stayed in the app, and any URL
token the change introduces.
