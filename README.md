# Kizlo Kit

Opinionated React components for headless WordPress, built on [Kizlo](https://github.com/kizlo-io/kizlo).

Two layers, deliberately separated.

**Bones are packages.** One per integration, each headless. The component owns the behaviour that is genuinely hard (the
URL contract, the server requests, the derived model, the pending state) and renders nothing but `children`. No markup, no
class names, no styling dependencies.

The bones are also framework-agnostic. A package's root entry is plain TypeScript, and each framework gets a thin adapter
on a subpath: `@kizlo/woocommerce-kit` holds the logic, `@kizlo/woocommerce-kit/react` binds it to React. Another framework means another
adapter, not another port.

**Skin is code you own.** Styled components arrive through a shadcn registry rather than an npm install, because styling is
the part everyone edits and a version bump is the wrong way to deliver it. That layer is not built yet.

The kits are opinionated on purpose. Picking the URL-state library, the faceting model and the data flow for you is the
whole point; a component that made those configurable would just hand the decisions back. Where an opinion does not fit,
the seam is documented rather than turned into an option.

This lives outside the Kizlo monorepo so the kits release on their own cadence, without a WordPress stack in CI.

## Packages

| Package | Covers |
| --- | --- |
| [`@kizlo/kit`](./packages/kit) | Shared primitives the kits build on. |
| [`@kizlo/woocommerce-kit`](./packages/woocommerce-kit) | WooCommerce storefronts: product collection, search, cart and checkout. |

More integrations get their own kit as they land, named by appending `-kit` to the integration package they wrap:
`@kizlo/cf7` is wrapped by `@kizlo/cf7-kit`, `@kizlo/acf` by `@kizlo/acf-kit`.

Everything is on 0.x. Until a 1.0 a minor may break the component API, and the changelog will say so.

## Getting started

```bash
pnpm install
pnpm build
```

| Command | Does |
| --- | --- |
| `pnpm build` | Build every package. |
| `pnpm dev` | Rebuild on change. |
| `pnpm typecheck` | Typecheck every package. |
| `pnpm test` | Run the unit tests. |
| `pnpm check` / `pnpm check:fix` | Biome lint and format. |

## Layout

```
packages/     published npm packages, one per integration
tooling/      shared tsconfigs and the composite GitHub Action
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Licensed under [Apache 2.0](./LICENSE).
