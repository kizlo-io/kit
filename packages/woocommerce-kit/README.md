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

Peer dependencies: `@kizlo/woocommerce` 0.11+ and `kizlo` 0.25+ always, plus `react` 19+ if you import a React entry, `nuqs`
2.10+ for the collection and `@tanstack/react-query` 5.102+ for `WooCommerceProvider`, the cart, checkout, search and store settings. Those last three are optional
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

The store's cart, every cart mutation, and the pending and error state around them. Five hooks, one per subject, and no cart
provider; the query library stays inside the package.

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
				<WooCommerceProvider locale="en-IN">{children}</WooCommerceProvider>
			</KizloProvider>
		</QueryClientProvider>
	)
}
```

`WooCommerceProvider` carries configuration and nothing else — `locale`, the `cartEnabled` gate for a route that seeds the
cache itself, and your `QueryClient`, read once from `QueryClientProvider` — which is why its context value does not change as
the cart does. There is no provider per feature: the hooks below read the Kizlo client from `KizloProvider` and the query client
from `WooCommerceProvider`.

Then each component reads the slice it needs. A product page has no line yet, so it calls `useCartItem()` without a key:

```tsx
"use client"
import { useCartItem } from "@kizlo/woocommerce-kit/react/cart"

export function AddToCart({ productId }: { productId: number }) {
	const { addItem, error, isPending, quantity } = useCartItem()

	return (
		<>
			<button aria-label="One fewer" {...quantity.decrementProps}>−</button>
			<input aria-label="Quantity" {...quantity.inputProps} />
			<button aria-label="One more" {...quantity.incrementProps}>+</button>
			<button disabled={isPending} onClick={() => addItem({ productId })} type="button">
				{isPending ? "Adding…" : "Add to cart"}
			</button>
			{error ? <p role="alert">{error.code === "CART_ITEM_EXISTS" ? "Already in your cart." : error.message}</p> : null}
		</>
	)
}
```

`quantity` is the whole control: the shopper's draft value, the range it stays in, and the props for each element. Without a key
there is no line to save it to, so `addItem` sends it — `addItem({ productId })` adds what the control shows, and an explicit
`addItem({ productId, quantity: 3 })` wins.

A line of the cart passes its key. The same control now writes back to the store, and the line gets its own pending state:

```tsx
"use client"
import { useCartItem } from "@kizlo/woocommerce-kit/react/cart"

export function CartLine({ itemKey }: { itemKey: string }) {
	const { format, isPending, item, quantity, remove } = useCartItem(itemKey)

	if (!item) return null

	return (
		<article aria-busy={isPending}>
			<h3>{item.name}</h3>
			<button aria-label="One fewer" {...quantity.decrementProps}>−</button>
			<input aria-label="Quantity" {...quantity.inputProps} />
			<button aria-label="One more" {...quantity.incrementProps}>+</button>
			<p>{format(item.totals.total)}</p>
			<button onClick={() => remove()} type="button">
				Remove
			</button>
		</article>
	)
}
```

Spreading the three bags is the whole control. The store's range, step and editability are already folded into each `disabled`, so
there is no conditional left for you to write, and the arithmetic stops at `limits.maximum` instead of asking the store for a
quantity it will reject.

An edit shows immediately and is saved 400ms later (`debounceMs`), so four quick `+` clicks are one request for the final value
rather than four requests — and a save in flight deliberately disables nothing, because that debounce is what collapses the burst.
Blur, Enter and `quantity.commit()` skip the wait; Escape abandons what was typed; a cart refetch leaves an edit that is still
owed alone, though text typed and not yet committed still follows the store; and an edit pending when the component unmounts is
sent rather than dropped, so a closing mini-cart keeps it.

| Field | Is |
| --- | --- |
| `value` | What the control shows: the pending edit while one is owed, otherwise `committed`. |
| `committed` | The quantity the store holds. Without a key, `value`. |
| `input` | What is in the field right now, which is not a quantity until it is committed. |
| `limits` | `{ editable, maximum, minimum, step }` — the store's for a line, the draft range without one. |
| `isDirty` | A save is owed. Always `false` without a key, where `addItem` is the commit. |
| `set(n)`, `commit()`, `revert()` | Set the quantity, save a pending edit now, or discard it. `set` is not awaitable behind a debounce; `set(5); await commit()` is. |

For an explicit "Update" button, pass `autoCommit: false` and call `quantity.commit()` yourself: an edit then sets `value` and
`isDirty` and waits, with `committed` still showing the store's quantity, and nothing is written without that call — an unmount
included. The keyless form takes its options first, so a product
that caps its own quantity is `useCartItem({ limits: { maximum: 5 } })` with no placeholder key.

| Hook | Returns |
| --- | --- |
| `useCart()` | `{ cart, items, itemCount, format, isLoading, isMutating, isRepricing, error, refresh }`. The cart as a whole and read-only: `cart` is the store's payload, so totals, coupons and addresses are read from it directly. It performs no action, so it takes no callbacks, and `error` is the fetch failing. |
| `useCartAddress(options?)` | `{ update, onAddressChange, isPending, error, reset }`. The customer's addresses. `update` takes whatever changed — a postcode alone is a valid save, and what makes the store re-quote shipping. The email is a field inside `billingAddress`. |
| `useCartShippingRates(options?)` | `{ shippingPackages, selectShippingRate, hasSelectedShippingRates, isPending, error, reset }`. The packages the store quoted and the choice of rate. `hasSelectedShippingRates` is the question `cart.hasCalculatedShipping` does not answer: whether a rate is in effect for every package, not whether one was costed. The store's own default rate counts, so it is not proof the shopper chose anything. |
| `useCartItem(key?, options?)` | `{ addItem, item, quantity, isPending, error, format, remove, reset }`. Everything item-shaped, `quantity` included as a whole control. The key is optional: without one the control is a draft and `addItem` sends it; with one it edits that line, and `item` is `null` once the key leaves the cart. |
| `useCartCoupon(code?, options?)` | `{ coupons, isPending, error, apply, remove, reset }`. The code is optional, the same way a line's key is: without one the hook is the apply field, with one it is that chip alone, and `remove()` takes no argument because the hook already knows its code. `coupons` is the whole list either way. |

One hook per subject, so each one's `isPending` and `error` describe its own action and nothing else: saving an address does not grey
the rate list, and removing one coupon leaves the apply button and every other chip enabled.

Each hook's last argument is its own [callbacks](#cart-events); `useCartItem` takes `autoCommit`, `debounceMs`,
`defaultQuantity` and `limits` there too; `useCartAddress` takes `addressDebounceMs` and `shouldUpdateAddress`. `useCart` takes nothing, because it performs no action. The client comes from
`KizloProvider` and the configuration from `WooCommerceProvider`, so there is nothing else to pass.

`format` is the store's currency and your locale already applied, so a line total is `format(item.totals.total)`. `isMutating`
is true while any cart action anywhere in the tree is in flight, which is what a page disables itself on; each action hook's
`isPending` narrows that to its own action — `useCartItem(key).isPending` to the one line saving, `useCartCoupon(code).isPending`
to the one chip. Both read the shared mutation cache, so a line saving in the drawer is also saving on the cart page, with no
state held above them.

`cart.errors` is a different thing from any hook's `error`: it is the store's own standing list of problems *with* the cart — a
line that went out of stock, a coupon that stopped applying — read straight off `cart` as `{ code, message }`. A hook's `error` is
the failure of the request that hook just made.

**An action returns nothing.** `addItem`, `remove`, `apply`, `update` and the rest report the outcome through callbacks
instead, so there is no promise to await and no call site needs a `try`/`catch`. The last failure stays on the hook's `error` as
`{ code, message }` — the store's code intact, so you can answer `CART_ITEM_EXISTS` in your own words — until `reset()`, the next
action or the next success clears it. `reset()` clears a failure that has settled; an action still in flight keeps reporting its
own outcome. `quantity.commit()` and `refresh()` are the two that still resolve, because each has something to wait
for: the save the control owes, and the refetch.

Every hook, the provider and the core functions carry a JSDoc example, so the shape above is also available from an editor's
hover.

### Address changes and pricing

Call `useCartAddress().onAddressChange(snapshot)` whenever the form values change. Pass the **whole current address**, not a
patch for the last field: every included address must have `country`, `state`, `city` and `postcode`, with empty strings for
unused fields. Include both addresses on every call if the form edits shipping and billing. The exported
`CartAddressSnapshotInput` type checks this contract. The form owns its values; the hook remembers only the latest snapshot.

After typing pauses for 1500ms (`addressDebounceMs` overrides this), the hook sends a qualifying snapshot through the same
`update_customer` action and callbacks as `update`. Fields stay editable. If an address request is already running, the latest
snapshot waits and is compared with the cart after that request finishes. Changing an address back while a request runs is
therefore saved too. A failed request reports the existing address error and is not automatically retried; the next qualifying
edit can send again without a dedupe reset. Returning to the saved address clears that settled error without another
request, so checkout can proceed again. The snapshot must include the addresses and fields from the failed save and match
all supplied saved values; invalid or unsaved values keep the error. Keep `update(input)` for immediate saves, which still accept partial input.

The default checks **country, state, city and postcode** in both shipping and billing, because tax can depend on billing.
Names, phone, company and street alone do not trigger a request. Postcode whitespace and case are ignored; the other three
fields are trimmed. A non-empty country is required, but postcode, state and city can be empty, since country rules differ.
A later name edit does not lose a pending postcode edit because each snapshot contains all current values.

```tsx
const { onAddressChange, error } = useCartAddress()
const { isRepricing } = useCart()

<ShippingAddressFields
	value={shippingAddress}
	onValuesChange={(nextAddress) => {
		setShippingAddress(nextAddress)
		onAddressChange({ shippingAddress: nextAddress })
	}}
/>
```

`ShippingAddressFields`, its values and validation are owned by your storefront. The fields are not disabled during repricing.
`shouldUpdateAddress(snapshot, cart)` **replaces** the default check, so it can combine form validation with pricing relevance
or include street for a carrier that needs it:

```tsx
const { onAddressChange } = useCartAddress({
	shouldUpdateAddress: (input, cart) => isValidAddress(input) && hasCarrierAddressChanged(input, cart),
})
```

A false predicate cancels queued work once any current address request has settled. Unmounting cancels that hook's queued
snapshot; an already dispatched request can still finish. The core exports `shippingQuoteSignature` and
`defaultShouldUpdateAddress` for comparisons outside React.

`useCart().isRepricing` is shared across components and covers both queued snapshots and actual address requests. Show
“Updating…” beside totals and guard checkout with it, while leaving the fields editable. `isMutating` covers actual cart
requests only; `useCartAddress().isPending` covers actual address requests only. A settled save failure clears repricing,
so also guard submission on the address hook's `error` and your own form validity. `useCheckout` does not wait for repricing
automatically: apply the guard in the submit handler as well as on the order button.

```tsx
const { cart, format, isRepricing } = useCart()
const { onAddressChange, error: addressError } = useCartAddress()
const { confirm, isPending } = useCheckout()
const canSubmit = isFormValid && !isRepricing && !addressError && !isPending

<form onSubmit={(event) => {
	event.preventDefault()
	if (!canSubmit) return
	confirm(values)
}}>
	<AddressFields values={values} onValuesChange={(addresses) => {
		setValues({ ...values, ...addresses })
		onAddressChange(addresses)
	}} />
	<p>{isRepricing ? "Updating…" : format(cart.totals.total)}</p>
	{addressError ? <p role="alert">{addressError.message}</p> : null}
	<button disabled={!canSubmit} type="submit">Place order</button>
</form>
```

The address writer and error reader should be the same `useCartAddress` instance: repricing is shared, but an action failure
belongs to the hook that performed it.

### Cart events

Callbacks go on the hook that performs the action. Each action reports `onStart` → `onSuccess` | `onError` → `onSettled`, and
every event carries the action's own payload, narrowed on `type`:

| `type` | Payload | Raised by |
| --- | --- | --- |
| `add_to_cart` | `input` | `useCartItem().addItem` |
| `update_cart_item` | `key`, `quantity`, `previousQuantity` | `useCartItem(key).quantity` |
| `remove_from_cart` | `key`, `item` | `useCartItem(key).remove` |
| `apply_coupon` | `code` | `useCartCoupon().apply` |
| `remove_coupon` | `code` | `useCartCoupon(code).remove` |
| `update_customer` | `input` | `useCartAddress().update` and `.onAddressChange` |
| `select_shipping_rate` | `rateId`, `packageId` | `useCartShippingRates().selectShippingRate` |

`onSuccess` adds the new `cart` and `onError` a `CartError`, whose `code` is the failing procedure's own token rather than a
bare `string`, with the `data` that code carries narrowed alongside it; `onSettled` is either, narrowed on `status`. The payload
is what makes these worth having: `remove_from_cart` carries the item that is already gone from `cart` by the time a listener
runs, and the item tokens match GA4's, since analytics is usually the reason to want them.

`onStart` is synchronous and cannot cancel the action; it is what lets a drawer open immediately instead of after the round
trip. A throwing listener is isolated: the action itself still succeeds, and the later phases still run. A concern that spans
the storefront — analytics, or the drawer — wires the same listener on each hook it cares about.

## Checkout

Checkout loads the store's checkout snapshot, confirms an order and keeps the cart hooks on the same cache entry. It owns no
form state and performs no navigation: validation, copy, fields, routes and payment redirects stay in the storefront. Needs
`KizloProvider` and `WooCommerceProvider` above it, which takes your query client from `QueryClientProvider`.

On the checkout route, disable the cart's own fetch through `WooCommerceProvider` so checkout can seed `cartQueryKey` without
racing a second request. Then use the live cart alongside it: `useCart()` for the totals, and the address, rate and coupon hooks
for the parts the shopper still changes — each reporting only its own save, so one pending request does not disable the rest of
the form:

```tsx
"use client"
import type { CartAddressSnapshotInput, ConfirmCheckoutInput } from "@kizlo/woocommerce-kit"
import { useCart, useCartAddress, useCartCoupon, useCartShippingRates } from "@kizlo/woocommerce-kit/react/cart"
import { useCheckout } from "@kizlo/woocommerce-kit/react/checkout"

export function CheckoutForm({ values, isFormValid, onAddressValuesChange }: {
	values: ConfirmCheckoutInput & CartAddressSnapshotInput
	isFormValid: boolean
	onAddressValuesChange: (addresses: CartAddressSnapshotInput) => void
}) {
	const { cart, isRepricing } = useCart()
	const { onAddressChange, error: addressError } = useCartAddress()
	const { selectShippingRate } = useCartShippingRates()
	const { apply: applyCoupon } = useCartCoupon()
	const { checkout, confirm, error, isLoading, isPending, refresh, reset } = useCheckout({
		onSuccess: ({ checkout, redirectUrl }) => {
			track("purchase", { orderId: checkout.orderId })
			if (redirectUrl) window.location.assign(redirectUrl)
		},
	})

	if (isLoading) return <Spinner />
	if (!checkout || !cart) {
		return <button onClick={() => void refresh()}>Try checkout again</button>
	}

	const canSubmit = isFormValid && !isRepricing && !addressError && !isPending

	return (
		<form
			onSubmit={(event) => {
				event.preventDefault()
				if (!canSubmit) return
				reset()
				confirm({ ...values, cancelPath: "/cart", successPath: "/checkout/order-received" })
			}}
		>
			<p>{cart.itemCount} items</p>
			<AddressFields values={values} onValuesChange={(addresses) => {
				onAddressValuesChange(addresses)
				onAddressChange(addresses)
			}} />
			<p>{isRepricing ? "Updating…" : "Totals are current"}</p>
			{addressError ? <p role="alert">{addressError.message}</p> : null}
			<button onClick={() => selectShippingRate("flat_rate:1", 0)} type="button">
				Choose shipping
			</button>
			<button onClick={() => applyCoupon("WELCOME10")} type="button">
				Apply coupon
			</button>
			{error ? <p role="alert">{error.message}</p> : null}
			<button disabled={!canSubmit} type="submit">Place order</button>
		</form>
	)
}
```

`AddressFields` and `onAddressValuesChange` belong to the storefront: the parent updates its form values and validity while
`onAddressChange` sends the same complete snapshot to the kit.

`confirm(input)` returns nothing: the order and where to send the browser next arrive on the success event. The last fetch or
confirmation failure is on `error`, including its store code and validation data. `reset()` clears a confirmation failure.

Confirmation uses the cart callback lifecycle: `onStart` → `onSuccess` | `onError` → `onSettled`, passed to `useCheckout`
itself. A throwing listener does not suppress a later phase or fail the confirmation:

```tsx
<WooCommerceProvider cartEnabled={!checkoutSeedsCart}>{children}</WooCommerceProvider>
```

The checkout fetch and `refresh()` do not emit action callbacks. Only confirmation does.

Navigate from the success event's `redirectUrl` rather than from `checkout.paymentResult`. It is the gateway's own
destination when there is one, and the store's return URL rebuilt from your `successPath` when the gateway names none —
WooCommerce's own client treats an empty redirect as "stay here", which leaves the shopper on the form with a placed order
behind them. It is `null` when you passed no `successPath`, and when there is no placed order to return to.

### The return route

Headless has no thank-you page, so the two routes the store returns to are yours to build. Name them on `confirm` as paths on
your own site; both are optional:

| Outcome | Destination | Query |
| -- | -- | -- |
| Placed | `successPath`, or `/checkout/order-received` | `order_id`, `key` |
| Cancelled at the gateway | `cancelPath`, or `/cart` | none |

The whole redirect is gated on a configured Kizlo Site URL. Without one the store has no origin to send the browser back to,
and `redirectUrl` is whatever the gateway gave you.

A placed order is not a paid one, so the success route reads the order and asks what to tell the shopper. Both functions are
pure and framework-agnostic, from the package root:

```tsx
// app/checkout/order-received/page.tsx
import { orderOutcome, parseCheckoutReturn } from "@kizlo/woocommerce-kit"
import { client } from "@/lib/kizlo/server"

export default async function OrderReceived({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
	const returned = parseCheckoutReturn(new URLSearchParams(Object.entries(await searchParams) as [string, string][]))
	if (!returned) return <p>We could not find that order.</p>

	const result = await client.woocommerce.orders.get({
		params: { orderId: returned.orderId },
		query: { key: returned.key },
	})
	if (!result.success) return <p>We could not find that order.</p>

	const { state } = orderOutcome(result.data)
	if (state === "paid") return <p>Thanks — your order is confirmed.</p>
	if (state === "failed") return <p>Your payment was declined and the order has not been placed.</p>
	return <p>Order received. We have emailed your payment instructions.</p>
}
```

`parseCheckoutReturn` takes the raw `location.search` or a `URLSearchParams`, and returns `null` rather than a bad request
when the query is missing or malformed. Its fields are what `orders.get` needs. Read the call's own envelope rather than
letting it throw: `result.error.code` is `ORDER_FORBIDDEN` or `ORDER_NOT_FOUND` when a shopper opens the return link from
another browser or after the key stops matching, which is likelier than a malformed query.

`orderOutcome(order)` reports `paid`, `awaiting_payment` or `failed`. It reads the store's own `isPaid`, which is filterable
in WooCommerce, so you never match a status string yourself: a bank transfer sitting on `on-hold` is `awaiting_payment`, cash
on delivery is `paid`, and a status a plugin invented is money still owed rather than a finished order. A declined order
reaches this route the same way — the store redirects on a 200 carrying a failed payment, and `failed` is what you get.

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

## Store settings and addresses

The store's own countries, states and address-field rules, so an address form needs nothing hardcoded. `useStorefront()`
fetches `storefront.get` once and shares it; the derivations are plain functions in the core that take `storefront.address`.

```tsx
"use client"
import { isAddressComplete, resolveAddressCountry, shippingCountries } from "@kizlo/woocommerce-kit"
import { useStorefront } from "@kizlo/woocommerce-kit/react/storefront"

export function ShippingAddress({ address }: { address: { country: string; state: string; postcode: string; city: string } }) {
	const { storefront } = useStorefront()
	if (!storefront) return <FreeTextAddressFields />

	const countries = shippingCountries(storefront.address)
	const { fields, states, stateLabel } = resolveAddressCountry(storefront.address, address.country)
	const isComplete = isAddressComplete(storefront.address, address)

	return <AddressFields isComplete={isComplete} countries={countries} fields={fields} stateLabel={stateLabel} states={states} />
}
```

| Function | Answers |
| --- | --- |
| `billingCountries(address)` / `shippingCountries(address)` | The countries the store bills to or ships to, in the store's order. |
| `addressFields(address, country)` | The country's address fields in display order: each default field overlaid with the country's locale, so `label`, `required`, `hidden` and `index` are what that country uses. Hidden fields are included; skip them when rendering. |
| `resolveAddressCountry(address, country)` | Everything a form needs for one country: its `fields`, its `states` (`[]` when it has none, so the state is free text or hidden) and `stateLabel`, the country's own name for that field — "Emirate", "County" — or the default label. |
| `isAddressComplete(address, input)` | Whether the shopper has filled in every field the store needs before it quotes shipping, by WooCommerce's own rule: a country, and each of country, state, postcode and city hidden, optional or filled for that country. |

An unknown or empty country code answers the default fields rather than throwing, so a form keeps rendering while the shopper
corrects it. A plugin-registered field may carry a JSON Schema rule object in `required` or `hidden` instead of a boolean; the
kit passes it through untouched, and `isAddressComplete` reads it as required and visible.

`isAddressComplete` checks completeness, not validity, exactly as WooCommerce's own check does. It does not check that the
store ships to the country or that the state belongs to it, so offer only `shippingCountries` in the country picker and clear
the state when the country changes.

The settings stay fresh for an hour (`storefrontStaleTime`): they change when a merchant edits WooCommerce, not while a shopper
browses. `refresh` refetches sooner. A failed request leaves `storefront` null and sets `error`, so fall back to free-text
fields rather than blanking the form. Needs `KizloProvider` and `WooCommerceProvider` above it, which takes your query
client from `QueryClientProvider`.

## Entry points

| Import | Contents |
| --- | --- |
| `@kizlo/woocommerce-kit` | The core. Collection grammar and model, cart and checkout cache keys and events, search request, href and cache helpers, quantity, money and address helpers, and every type. No framework. |
| `@kizlo/woocommerce-kit/react` | `ProductCollectionProvider`, `useProductCollection`, and the model types it returns. Carries `"use client"`. |
| `@kizlo/woocommerce-kit/react/cart` | `useCart`, `useCartAddress`, `useCartShippingRates`, `useCartItem`, `useCartCoupon`. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/checkout` | `useCheckout` and its callback types. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/provider` | `WooCommerceProvider`, this kit's app-level configuration. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/search` | `useProductSearch`. Carries `"use client"`. Needs `@tanstack/react-query`. |
| `@kizlo/woocommerce-kit/react/server` | `ProductCollection`, the server component. |
| `@kizlo/woocommerce-kit/react/storefront` | `useStorefront`, `storefrontQueryKey` and `storefrontStaleTime`. Carries `"use client"`. Needs `@tanstack/react-query`. |

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
