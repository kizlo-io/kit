# @kizlo/woocommerce-kit

Headless React components for WooCommerce storefronts, built on [Kizlo](https://github.com/kizlo-io/kizlo).

Behaviour, not markup. Each component owns the hard parts (the URL contract, the store requests, the facet model, the
pending state) and renders nothing but `children`, so the design is entirely yours.

The bones are framework-agnostic. `@kizlo/woocommerce-kit` itself is plain TypeScript: the URL grammar, the store requests, the
derived model and the cart and checkout contracts, with no React and no URL-state library. Framework bindings are separate
[entry points](#entry-points) — one per feature, so you resolve only what you use — and each is a thin adapter over that core.

```bash
pnpm add @kizlo/woocommerce-kit
```

Peer dependencies: `@kizlo/woocommerce` 0.8+ and `kizlo` 0.25+ always, plus `react` 19+ if you import a React entry, `nuqs`
2.10+ for the collection and `@tanstack/react-query` 5.102+ for the cart, checkout and search. Those last three are optional
peers, so a different framework's adapter does not drag React in and a collection-only storefront installs no query library.
Your app supplies the Kizlo client, through `KizloProvider` from [`kizlo/react`](https://www.npmjs.com/package/kizlo) for
client components and as a prop for server components.

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
import { KizloProvider } from "kizlo/react"
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

Every hook takes one optional argument: its own [callbacks](#cart-events). The client comes from `KizloProvider` and the
configuration from `WooCommerceProvider`, so there is nothing else to pass.

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

`onSuccess` adds the new `cart` and `onError` a `CartError`, whose `code` is the failing procedure's own token rather than a
bare `string`, with the `data` that code carries narrowed alongside it; `onSettled` is either, narrowed on `status`. The payload
is what makes these worth having: `remove_from_cart` carries the item that is already gone from `cart` by the time a listener
runs, and the item tokens match GA4's, since analytics is usually the reason to want them.

`WooCommerceProvider`'s callbacks fire for every cart and checkout action below it, which is where an analytics or drawer
concern belongs — once, rather than at each call site. `onStart` is synchronous and cannot cancel the action; it is what lets a
drawer open immediately instead of after the round trip.

## Checkout

Checkout loads the store's checkout snapshot, confirms an order and keeps the cart hooks on the same cache entry. It owns no
form state and performs no navigation: validation, copy, fields, routes and payment redirects stay in the storefront.

On the checkout route, disable the cart's own fetch through `WooCommerceProvider` so checkout can seed `cartQueryKey` without
racing a second request. Then use the live cart from `useCart()` for customer details, shipping rates and coupons:

```tsx
"use client"
import type { ConfirmCheckoutInput } from "@kizlo/woocommerce-kit"
import { useCart, useCartCoupon } from "@kizlo/woocommerce-kit/react/cart"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"

export function CheckoutForm({ values }: { values: ConfirmCheckoutInput }) {
	const { cart, selectShippingRate, updateCustomer } = useCart()
	const { apply: applyCoupon } = useCartCoupon()
	const { checkout, confirm, error, isLoading, isPending, refresh, reset } = useCheckout({
		onSuccess: ({ checkout }) => track("purchase", { orderId: checkout.orderId }),
	})

	if (isLoading) return <Spinner />
	if (!checkout || !cart) {
		return <button onClick={() => void refresh()}>Try checkout again</button>
	}

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				reset()
				void confirm(values).then((result) => {
					if (result?.paymentResult?.redirectUrl) window.location.assign(result.paymentResult.redirectUrl)
				})
			}}
		>
			<p>{cart.itemCount} items</p>
			<button onClick={() => void updateCustomer({ shippingAddress: values.shippingAddress })} type="button">
				Calculate shipping
			</button>
			<button onClick={() => void selectShippingRate("flat_rate:1", 0)} type="button">
				Choose shipping
			</button>
			<button onClick={() => void applyCoupon("WELCOME10")} type="button">
				Apply coupon
			</button>
			{error ? <p role="alert">{error.message}</p> : null}
			<button disabled={isPending} type="submit">Place order</button>
		</form>
	)
}
```

`confirm(input)` resolves to the new checkout, or `null` when it fails; it never rejects. The last fetch or confirmation
failure is on `error`, including its store code and validation data. `reset()` clears a confirmation failure.

Confirmation uses the cart callback lifecycle: `onStart` → `onSuccess` | `onError` → `onSettled`. Pass callbacks to
`useCheckout` for one form, or to `WooCommerceProvider` for every cart and checkout action in the tree. Hook callbacks run
first, and one throwing does not suppress the other callback or phase:

```tsx
<WooCommerceProvider
	cartEnabled={!checkoutSeedsCart}
	onSuccess={(event) => {
		if (event.type === "confirm_checkout") track("purchase", { orderId: event.checkout.orderId })
	}}
>
	{children}
</WooCommerceProvider>
```

The checkout fetch and `refresh()` do not emit action callbacks. Only confirmation does.

## Search

A product typeahead: the field state, the debounce, the store request and the link to the full results. One hook, no provider,
and no markup.

Search is browser state for the same reason the cart is — it lives in the app shell and fetches per keystroke — but it writes no
URL of its own. It sends the shopper to the collection's `q` parameter, so the results *page* is the server-rendered
`ProductCollection` you already have, and the panel is the only client half.

```tsx
"use client"
import { useProductSearch } from "@kizlo/woocommerce-kit/react/search"
import { useState } from "react"

export function ProductSearch({ category }: { category: string | null }) {
	const [isOpen, setOpen] = useState(false)
	const collectionPath = category ? `/collections/${category}` : "/collections"
	const { clear, inputProps, isLoading, isRefreshing, products, resultsHref, unavailable } = useProductSearch({
		active: isOpen,
		browseSort: { order: "desc", orderBy: "popularity" },
		collectionPath,
		filters: { category: category || undefined },
		onQueryChange: () => setOpen(true),
		onResults: (results, query) => track("view_search_results", { count: results.length, query }),
	})

	return (
		<search>
			<input aria-expanded={isOpen} onChange={inputProps.onChange} placeholder="Search products" value={inputProps.value} />
			<button onClick={clear} type="button">Clear</button>
			{isOpen ? (
				<div aria-busy={isRefreshing}>
					{isLoading ? <ResultSkeletons /> : products.map((product) => <Result key={product.id} product={product} />)}
					{unavailable ? <p role="alert">Search is unavailable right now.</p> : null}
					<a href={resultsHref ?? collectionPath}>View all results</a>
				</div>
			) : null}
		</search>
	)
}
```

| Returns | Is |
| --- | --- |
| `query`, `setQuery`, `inputProps` | What is in the field. `inputProps` is `{ onChange, value }` — the id, the aria attributes and the placeholder stay yours, because you own the panel they describe. |
| `debouncedQuery` | The term the visible results answer. |
| `products` | The store's products, raw. Empty until there is something to show. |
| `isLoading` / `isRefreshing` | Nothing on screen yet, versus the previous results still up while the next arrive. |
| `unavailable` | There is nothing to show and the last request is why. A failure behind results already on screen does not set it. |
| `resultsHref` | The full results page for what is in the field **now**, or `null` when it is empty. It follows the field rather than the debounce, so submitting straight after typing reaches the typed term. Render it, push it, or prefetch it on hover — it names a destination, not a use. |
| `clear` | Empties the field and the settled term. |

`collectionPath` is the only required option, and it is required rather than configured: a scope control changes it between
renders, so a single route value could not describe it. Everything else is behaviour — `active` (pass your open state; a closed
panel asks the store nothing), `browseSort`, `debounceMs` (240), `filters`, `perPage` (10) and `staleTime`. The client comes
from `KizloProvider`.

**An empty field asks the store nothing unless you say otherwise.** Leave `browseSort` out and a panel stays blank until
someone types; pass an ordering and the empty field browses in it — `{ order: "desc", orderBy: "popularity" }` for the best
sellers. There is no default, because whether a resting panel shows products at all is a storefront's decision, not this
package's. Once a term arrives the ordering is dropped and the store sorts by relevance, which is the only sensible ranking for
a search.

`filters` is what keeps a scope control working: it narrows the request and separates the cache entry, so a category's results
never land in the unnarrowed one. The kit knows nothing about categories beyond that passthrough — the control, its labels and
its navigation are yours.

Needs `KizloProvider` and your `QueryClientProvider` above it. It reads no kit configuration, so a storefront that only wants
search mounts no `WooCommerceProvider`.

### Search events

| Callback | Fires |
| --- | --- |
| `onQueryChange(query)` | On every change to the field, **before** the debounce. This is what opens a panel on the first keystroke instead of on the first result. |
| `onSearchStart(query)` | Once per request that leaves, including a refetch and one that supersedes a request still in flight. |
| `onResults(products, query)` | When results for a settled term arrive — a `view_search_results` event, or a live-region count. |
| `onError(error, query)` | On every failed request, including one whose results are still on screen. Check `unavailable` instead if you only want to complain when the panel is empty. |
| `onClear()` | When `clear` runs. |

A throwing listener is re-raised on its own, so it reaches your error handling without breaking the hook. A hook with
`active: false` reports nothing and never claims to be refreshing, so a second panel sharing the cache entry — a mobile drawer
beside a desktop header — does not narrate the open one's requests.

## Entry points

| Import | Contents |
| --- | --- |
| `@kizlo/woocommerce-kit` | The core. Collection grammar and model, cart and checkout cache keys and events, search request, href and cache helpers, quantity and money helpers, and every type. No framework. |
| `@kizlo/woocommerce-kit/react` | `ProductCollectionProvider`, `useProductCollection`, and the model types it returns. Carries `"use client"`. |
| `@kizlo/woocommerce-kit/react/cart` | `useCart`, `useCartItem`, `useCartCoupon`, `useQuantityInput`. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/checkout` | `useCheckout` and its callback types. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/provider` | `WooCommerceProvider`, this kit's app-level configuration. Carries `"use client"`. Imports no peer but React. |
| `@kizlo/woocommerce-kit/react/search` | `useProductSearch`. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/server` | `ProductCollection`, the server component. |

The React split across feature entries is an RSC constraint rather than a preference. A `"use client"` module imported by a
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
