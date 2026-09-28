# @kizlo/woocommerce-kit

Headless React components for WooCommerce storefronts, built on [Kizlo](https://github.com/kizlo-io/kizlo).

Behaviour, not markup. Each component owns the hard parts (the URL contract, the store requests, the facet model, the
pending state) and renders nothing but `children`, so the design is entirely yours.

The bones are framework-agnostic. `@kizlo/woocommerce-kit` itself is plain TypeScript: the URL grammar, the store requests, the
derived model and the cart's own contract, with no React and no URL-state library. Framework bindings are separate
[entry points](#entry-points) — one per feature, so you resolve only what you use — and each is a thin adapter over that core.

```bash
pnpm add @kizlo/woocommerce-kit
```

Peer dependencies: `@kizlo/woocommerce` 0.8+ always, plus `react` 19+ if you import a React entry, `nuqs` 2.10+ for the
collection and `@tanstack/react-query` 5.102+ for the cart. All three are optional peers, so a different framework's adapter
does not drag React in and a collection-only storefront installs no query library. Your app supplies the Kizlo client, through
[`KizloProvider`](../kit#kizloprovider-and-usekizloclient) for client components and as a prop for server components.

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

## Cart

The store's cart, every cart mutation, and the pending and error state around them. Three hooks and no cart provider; the query
library stays inside the package.

The cart is session state behind a cookie, so it is fetched in the browser instead of server-rendered — there is no server half
to mount, and **no cart provider**. Three mounts, all app-level: your `QueryClientProvider`, `KizloProvider` with your
**browser** Kizlo client, and `WooCommerceProvider` for this kit's configuration. Sharing your query client is deliberate — it
keeps the cart in one cache entry your own code can read and seed — and the kit never creates a client or sets a global default.

```tsx
// app/providers.tsx
"use client"
import { KizloProvider } from "@kizlo/kit/react"
import { WooCommerceProvider } from "@kizlo/woocommerce-kit/react/provider"
import { QueryClientProvider } from "@tanstack/react-query"
import { client } from "@/lib/kizlo/client"
import { queryClient } from "@/lib/query-client"

export function Providers({ children }) {
	return (
		<QueryClientProvider client={queryClient}>
			<KizloProvider client={client}>
				<WooCommerceProvider
					locale="en-IN"
					onStart={(event) => {
						if (event.type === "add_to_cart") openCartDrawer()
					}}
				>
					{children}
				</WooCommerceProvider>
			</KizloProvider>
		</QueryClientProvider>
	)
}
```

`WooCommerceProvider` carries configuration and nothing else — `locale`, the `cartEnabled` gate for a route that seeds the cache
itself, and the kit-level cart callbacks — which is why its context value does not change as the cart does. There is no provider
per feature: the hooks below read the client from `KizloProvider` and the cart from your `QueryClient`.

Then each component reads the slice it needs. A product page has no line yet, so it calls `useCartItem()` without a key:

```tsx
"use client"
import { useCartItem } from "@kizlo/woocommerce-kit/react/cart"

export function AddToCart({ productId }: { productId: number }) {
	const { addItem, error, isPending } = useCartItem()

	return (
		<>
			<button disabled={isPending} onClick={() => void addItem({ productId, quantity: 1 })} type="button">
				{isPending ? "Adding…" : "Add to cart"}
			</button>
			{error ? <p role="alert">{error.code === "CART_ITEM_EXISTS" ? "Already in your cart." : error.message}</p> : null}
		</>
	)
}
```

A line of the cart passes its key, and gets that line's own pending state:

```tsx
"use client"
import { useCartItem, useQuantityInput } from "@kizlo/woocommerce-kit/react/cart"

export function CartLine({ itemKey }: { itemKey: string }) {
	const { format, isPending, item, limits, quantity, remove, setQuantity } = useCartItem(itemKey)
	const field = useQuantityInput({
		maximum: limits.maximum,
		minimum: limits.minimum,
		onValueChange: setQuantity,
		step: limits.step,
		value: quantity,
	})

	if (!item) return null

	return (
		<article aria-busy={isPending}>
			<h3>{item.name}</h3>
			<input aria-label="Quantity" disabled={!limits.editable} {...field.inputProps} />
			<button disabled={!field.canIncrement} onClick={field.increment} type="button">
				+
			</button>
			<p>{format(item.totals.total)}</p>
			<button onClick={() => void remove()} type="button">
				Remove
			</button>
		</article>
	)
}
```

| Hook | Returns |
| --- | --- |
| `useCart(options?)` | `{ cart, items, itemCount, format, isLoading, isMutating, error, refresh, updateCustomer, selectShippingRate, reset }`. The cart as a whole: `cart` is the store's payload, so totals, coupons and addresses are read from it directly. It has no add action — that is item-shaped work. |
| `useCartItem(key?, options?)` | `{ addItem, item, quantity, limits, isPending, error, format, setQuantity, remove, reset }`. Everything item-shaped. The key is optional: without one you get `addItem` for a product page; with one, the full line API, and `item` is `null` once the key leaves the cart. |
| `useCartCoupon(options?)` | `{ coupons, isPending, error, apply, remove, reset }`. |
| `useQuantityInput(options)` | `{ input, inputProps, increment, decrement, canIncrement, canDecrement }` — the behaviour of a quantity control, no markup. Commits on blur and Enter, abandons on Escape. |

Every hook takes one optional argument: its own [callbacks](#cart-events), plus a `client` to use instead of the one from
`KizloProvider` — a stub in a test, or a second store. A storefront passes neither.

`format` is the store's currency and your locale already applied, so a line total is `format(item.totals.total)`. `isMutating`
is true while any cart action anywhere in the tree is in flight, which is what a page disables its controls on;
`useCartItem(key).isPending` narrows that to the one line that is saving. Both read the shared mutation cache, so a line saving
in the drawer is also saving on the cart page, with no state held above them.

**No action rejects.** `addItem`, `setQuantity`, `remove`, `apply` and the rest return `Promise<void>` and report the outcome
through callbacks instead, so no call site needs a `try`/`catch`. The last failure stays on the hook's `error` as
`{ code, message }` — the store's code intact, so you can answer `CART_ITEM_EXISTS` in your own words — until `reset()` or the
next success clears it.

Every hook, the provider and the core functions carry a JSDoc example, so the shape above is also available from an editor's
hover.

### Cart events

Callbacks go on `WooCommerceProvider`, on a hook, or both; the hook's run first, and one throwing does not stop the other. Each
action reports `onStart` → `onSuccess` | `onError` → `onSettled`, and every event carries the action's own payload, narrowed on
`type`:

| `type` | Payload | Raised by |
| --- | --- | --- |
| `add_to_cart` | `input` | `useCartItem().addItem` |
| `update_cart_item` | `key`, `quantity`, `previousQuantity` | `useCartItem(key).setQuantity` |
| `remove_from_cart` | `key`, `item` | `useCartItem(key).remove` |
| `apply_coupon` | `code` | `useCartCoupon().apply` |
| `remove_coupon` | `code` | `useCartCoupon().remove` |
| `update_customer` | `input` | `useCart().updateCustomer` |
| `select_shipping_rate` | `rateId`, `packageId` | `useCart().selectShippingRate` |

`onSuccess` adds the new `cart` and `onError` a `CartError`; `onSettled` is either, narrowed on `status`. The payload is what
makes these worth having: `remove_from_cart` carries the item that is already gone from `cart` by the time a listener runs, and
the item tokens match GA4's, since analytics is usually the reason to want them.

`WooCommerceProvider`'s callbacks fire for every cart action below it, which is where an analytics or drawer concern belongs —
once, rather than at each call site. `onStart` is synchronous and cannot cancel the action; it is what lets a drawer open
immediately instead of after the round trip.

## Entry points

| Import | Contents |
| --- | --- |
| `@kizlo/woocommerce-kit` | The core. `parseCollectionQuery`, `serializeCollectionQuery`, `loadProductCollection`, `buildCollectionModel`, the sort presets, the client contracts, `cartQueryKey`, `cartStaleTime`, `cartItemLimits`, `resolveQuantity`, `formatStoreMoney` and every type. No framework. |
| `@kizlo/woocommerce-kit/react` | `ProductCollectionProvider`, `useProductCollection`, and the model types it returns. Carries `"use client"`. |
| `@kizlo/woocommerce-kit/react/cart` | `useCart`, `useCartItem`, `useCartCoupon`, `useQuantityInput`. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/provider` | `WooCommerceProvider`, this kit's app-level configuration. Carries `"use client"`. Imports no peer but React. |
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
