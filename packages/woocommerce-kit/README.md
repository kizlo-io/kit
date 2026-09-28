# @kizlo/woocommerce-kit

Headless React components for WooCommerce storefronts, built on [Kizlo](https://github.com/kizlo-io/kizlo).

Behaviour, not markup. Each component owns the hard parts (the URL contract, the store requests, the facet model, the
pending state) and renders nothing but `children`, so the design is entirely yours.

The bones are framework-agnostic. `@kizlo/woocommerce-kit` itself is plain TypeScript: the URL grammar, the store requests and the
derived model, with no React and no URL-state library. Framework bindings are separate entry points, `@kizlo/woocommerce-kit/react`
today, and each one is a thin adapter over that core.

```bash
pnpm add @kizlo/woocommerce-kit
```

Peer dependencies: `@kizlo/woocommerce` 0.8+ always, plus `react` 19+ and `nuqs` 2.10+ if you import the React entry. Both
are optional peers, so a different framework's adapter does not drag React in. Your app supplies the Kizlo client.

## Product collection

A filterable, sortable, paginated product listing. Two store requests per render, both server-side, no client fetching and
nothing to hydrate.

Mount the server half on the page and pass it your Kizlo server client:

```tsx
// app/collections/[slug]/page.tsx
import { ProductCollection } from "@kizlo/woocommerce-kit/react/server"
import { client } from "@/lib/kizlo/server"

export default async function CollectionPage({ params, searchParams }) {
	const { slug } = await params

	return (
		<ProductCollection
			attributeTaxonomies={["pa_color", "pa_size"]}
			client={client}
			scope={{ taxonomy: "product_cat", term: slug }}
			searchParams={searchParams}
		>
			<Filters />
			<Sort />
			<Grid />
		</ProductCollection>
	)
}
```

Then read everything from one hook in your own client components:

```tsx
"use client"
import { useProductCollection } from "@kizlo/woocommerce-kit/react"

export function Filters() {
	const { filters } = useProductCollection()

	return filters.groups.map((group) => (
		<fieldset key={group.id}>
			<legend>{group.label}</legend>
			{group.terms.map((term) => (
				<label key={term.value}>
					<input checked={term.selected} onChange={() => term.toggle()} type="checkbox" />
					{term.label} ({term.count})
				</label>
			))}
		</fieldset>
	))
}
```

`useProductCollection()` returns `{ filters, products, scope, sort }`. Filter changes write the URL with `shallow: false`,
which re-runs the server component, so the next result set is fetched there and arrives as props. `filters.isPending` and
`products.isPending` cover that round trip.

Classifications are `scope`, not facets: the page is its taxonomy term, and moving between terms is navigation. `scope`
hands you the counted tree around the current term for rendering as links.

## URL contract

The collection's state lives entirely in the URL, which makes every view shareable, linkable and crawlable. These tokens
are public API: they end up in shared links and sitemaps, so they are treated as breaking to change.

| Parameter | Shape | Notes |
| --- | --- | --- |
| `page` | integer | Omitted at page 1. Reset by every filter change. |
| `q` | string | Free-text search. |
| `sort` | preset token | One of your `sortPresets` values. The first preset is the default order and stays out of the URL. |
| `attribute` | repeated `taxonomy:slug` | One entry per selected term, e.g. `attribute=pa_color:blue&attribute=pa_size:l`. |
| `minPrice` / `maxPrice` | number | Major units, e.g. `10.5`. Converted to the store's minor units server-side. |
| `stock` | repeated status | `instock`, `outofstock` or `onbackorder`. |

The scope is not in here. The page *is* its taxonomy term, so moving between terms is a route change.

## Entry points

| Import | Contents |
| --- | --- |
| `@kizlo/woocommerce-kit` | The core. `parseCollectionQuery`, `serializeCollectionQuery`, `loadProductCollection`, `buildCollectionModel`, the sort presets, the client contract and every type. No framework. |
| `@kizlo/woocommerce-kit/react` | `ProductCollectionProvider`, `useProductCollection`. Carries `"use client"`. |
| `@kizlo/woocommerce-kit/react/server` | `ProductCollection`, the server component. |

The React split into two entries is an RSC constraint rather than a preference. A `"use client"` module imported by a
server component becomes a client reference, so anything both halves need at runtime has to sit in a module with no
directive at all, which is what the core is.

## Building an adapter for another framework

The core is the whole component minus the rendering, so an adapter is small. It parses the URL, loads, builds the model
and supplies a writer:

```ts
import { buildCollectionModel, loadProductCollection, parseCollectionQuery } from "@kizlo/woocommerce-kit"

const query = parseCollectionQuery(url.searchParams)
const collection = await loadProductCollection({ attributeTaxonomies, client, query, scope })
const model = buildCollectionModel({ ...collection, query, scope, write: (patch) => navigate(patch) })
```

`write` receives a patch where `null` clears a parameter. How that reaches the URL is the framework's business; the rule
that any refinement resets paging is the core's, and it is already applied.
