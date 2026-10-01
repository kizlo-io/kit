"use client"

/**
 * React adapter for product search: one hook, no provider.
 *
 * Its own entry point rather than an addition to `./client`, because a typeahead needs a query library and the collection needs
 * a URL-state library; sharing one chunk would make a collection-only consumer resolve a dependency it never installed.
 *
 * The client comes from `KizloProvider` and the results from the app's `QueryClient`, so a storefront mounts nothing for this
 * feature. There is no provider and no shared model: a search panel is one component's state, and the collection path is the
 * only thing it needs from the app, passed per call because a scope control changes it between renders.
 *
 * React Query is an implementation detail: no hook returns one of its result objects, no consumer imports it, and the kit never
 * creates a client or sets a global default.
 *
 * Renders nothing. The panel, its dismissal, every class name, icon, label and skeleton, and the router call stay in the
 * consumer.
 */

import { isServer, keepPreviousData, skipToken, useQuery } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useDebouncedCallback } from "use-debounce"
import {
	defaultProductSearchPerPage,
	type ProductSearchSort,
	productSearchHref,
	productSearchQueryKey,
	productSearchStaleTime,
	resolveProductSearchRequest,
} from "../search"
import type { ListProductInput, Product } from "../types"
import { notify } from "./notify"

/**
 * The core's search types, re-exported so a component reads its hook and the types around it from one specifier. Type-only, so
 * nothing reaches the bundle.
 */
export type { ProductSearchHrefInput, ProductSearchSort, ProductSearchState } from "../search"

/** Stable empty, so a consumer mapping `products` before the first result does not see a new array every render. */
const noProducts: readonly Product[] = []

function useLatest<T>(value: T) {
	const ref = useRef(value)
	useEffect(() => {
		ref.current = value
	}, [value])
	return ref
}

/**
 * What the app wants to hear about, so it can drive the state the kit deliberately does not own — the panel, a live region, an
 * analytics event. A throwing listener does not stop the hook.
 *
 * An inactive hook stays silent: two panels sharing one cache entry would otherwise both narrate whichever one is open.
 */
export type ProductSearchCallbacks = {
	/** The field was cleared through `clear`. Close the panel here, or restore its resting content. */
	onClear?: () => void
	/**
	 * The request for `query` failed. Fires on every failure, including one whose results are still on screen — an app that only
	 * wants to complain when there is nothing to show can check `unavailable` instead.
	 */
	onError?: (error: unknown, query: string) => void
	/** Every change to the field, before the debounce. Open the panel here rather than waiting for results. */
	onQueryChange?: (query: string) => void
	/** Results for a settled `query` arrived. A `view_search_results` event or a live-region count goes here. */
	onResults?: (products: readonly Product[], query: string) => void
	/** A request for a settled `query` left. Fires once per request, including a refetch and one that supersedes another. */
	onSearchStart?: (query: string) => void
}

export type ProductSearchOptions = ProductSearchCallbacks & {
	/**
	 * Whether the panel may fetch. Pass your own open state: a closed typeahead should not query the store. Defaults to `true`
	 * for a panel that is always mounted, which costs nothing until either something is typed or `browseSort` is given.
	 */
	active?: boolean
	/**
	 * How to order the field while it is empty, for a panel that shows products before anything is typed.
	 *
	 * Leave it out and an empty field makes no request at all: `products` stays empty and the panel shows whatever resting
	 * content you like. Pass an ordering — `{ order: "desc", orderBy: "popularity" }` for the best sellers — and an empty field
	 * browses in it. There is no default, because what a resting panel shows is a storefront's decision.
	 */
	browseSort?: ProductSearchSort
	/**
	 * Where the results live, as this render resolved it: `"/collections"`, or `"/collections/bags"` while a scope control has a
	 * category. Required, because a route literal belongs to the app.
	 */
	collectionPath: string
	/** How long typing settles before a request leaves. */
	debounceMs?: number
	/**
	 * Extra listing parameters, e.g. `{ category: "bags" }` for a scope control. Merged into the request and folded into the
	 * cache identity, so a narrowed panel neither reads nor overwrites the unnarrowed results.
	 */
	filters?: Partial<ListProductInput>
	perPage?: number
	staleTime?: number
}

export type ProductSearchApi = {
	/** Empties the field and the settled term, then reports `onClear`. */
	clear: () => void
	/** The term the current results answer, which trails `query` by the debounce. */
	debouncedQuery: string
	/** Spread onto an `input`. Behaviour only: the id, the aria attributes, the placeholder and focus stay yours. */
	inputProps: {
		onChange: (event: ChangeEvent<HTMLInputElement>) => void
		value: string
	}
	/** No results for this state yet — the first request for it is still out. */
	isLoading: boolean
	/** The previous results are on screen while the next ones arrive. */
	isRefreshing: boolean
	/** The store's products, raw. Empty until there is something to show. */
	products: readonly Product[]
	/** What is in the field right now. */
	query: string
	/**
	 * The full results page for what is in the field now, or `null` when it is empty. Render it, push it on submit, prefetch it
	 * on hover — it names a destination, not a use.
	 */
	resultsHref: string | null
	setQuery: (query: string) => void
	/** There is nothing to show and the last request is why. A failure behind results already on screen does not set it. */
	unavailable: boolean
}

/**
 * A product typeahead: the field state, the debounce, the store request and the link to the full results.
 *
 * Everything that has to look a certain way is yours. The hook owns no panel, no dismissal and no navigation, because a panel
 * that opens on focus and one that opens on a keystroke are the same request with different markup.
 *
 * An empty field asks the store nothing unless you pass `browseSort`, so a panel that stays blank until someone types costs no
 * request at all.
 *
 * Needs `KizloProvider` and the app's `QueryClientProvider` above it. It takes no client, and it reads no kit configuration, so
 * it works in a storefront that mounts no `WooCommerceProvider`.
 *
 * Fails soft: when a request fails and there is nothing on screen, `products` is empty and `unavailable` is true; when results
 * are already up, they stay. Nothing throws.
 *
 * @example A header typeahead that owns its own panel, and shows the best sellers before anything is typed
 * ```tsx
 * "use client"
 * import { useProductSearch } from "@kizlo/woocommerce-kit/react/search"
 * import { useState } from "react"
 *
 * export function ProductSearch({ category }: { category: string | null }) {
 * 	const [isOpen, setOpen] = useState(false)
 * 	const collectionPath = category ? `/collections/${category}` : "/collections"
 * 	const { clear, inputProps, isLoading, isRefreshing, products, resultsHref, unavailable } = useProductSearch({
 * 		active: isOpen,
 * 		browseSort: { order: "desc", orderBy: "popularity" },
 * 		collectionPath,
 * 		filters: { category: category || undefined },
 * 		onQueryChange: () => setOpen(true),
 * 		onResults: (results, query) => track("view_search_results", { count: results.length, query }),
 * 	})
 *
 * 	return (
 * 		<search>
 * 			<input aria-expanded={isOpen} onChange={inputProps.onChange} placeholder="Search" value={inputProps.value} />
 * 			<button onClick={clear} type="button">Clear</button>
 * 			{isOpen ? (
 * 				<div aria-busy={isRefreshing}>
 * 					{isLoading ? <Skeletons /> : products.map((product) => <Result key={product.id} product={product} />)}
 * 					{unavailable ? <p role="alert">Search is unavailable.</p> : null}
 * 					<a href={resultsHref ?? collectionPath}>View all results</a>
 * 				</div>
 * 			) : null}
 * 		</search>
 * 	)
 * }
 * ```
 *
 * @example Submitting the field, which is the app's own navigation
 * ```tsx
 * const router = useRouter()
 * const { resultsHref } = useProductSearch({ collectionPath: "/collections" })
 *
 * // `resultsHref` follows the field rather than the debounce, so this reaches the term as typed.
 * <form onSubmit={(event) => {
 * 	event.preventDefault()
 * 	if (resultsHref) router.push(resultsHref)
 * }} />
 * ```
 */
export function useProductSearch({
	active = true,
	browseSort,
	collectionPath,
	debounceMs = 240,
	filters,
	perPage = defaultProductSearchPerPage,
	staleTime = productSearchStaleTime,
	...callbacks
}: ProductSearchOptions): ProductSearchApi {
	const { client } = useKizloContext()
	const listeners = useLatest<ProductSearchCallbacks>(callbacks)
	const [query, setQueryState] = useState("")
	const [debouncedQuery, setDebouncedQuery] = useState("")
	const settleQuery = useDebouncedCallback(setDebouncedQuery, debounceMs)

	const request = resolveProductSearchRequest({ browseSort, filters, perPage, query: debouncedQuery })

	const search = useQuery({
		// A typeahead is browser state: it has no server half, and a closed panel has no reason to ask the store anything.
		enabled: active && !isServer,
		// The previous term's results stay on screen while the next ones arrive, so the panel does not blink between keystrokes.
		placeholderData: keepPreviousData,
		// No request to make — an empty field with no browse ordering. `skipToken` is how that stays a fact of the query rather
		// than a cast inside the function.
		// React Query reports a failure by rejection, which is what `.call` does.
		queryFn: request ? () => client.woocommerce.products.list.call({ query: request }) : skipToken,
		queryKey: productSearchQueryKey({ browseSort, filters, perPage, query: debouncedQuery }),
		staleTime,
	})

	// React Query keeps the last good data alongside an error, so a failed *refetch* must not empty a panel the shopper is
	// reading. Only a failure with nothing behind it is reported as unavailable.
	const unavailable = search.isError && search.data === undefined
	const products = search.data?.items ?? noProducts

	// Fetching with nothing on screen is loading; fetching with results still up is refreshing.
	const isLoading = search.isPending && search.isFetching
	const isRefreshing = active && search.isFetching && !search.isPending

	/**
	 * One report per request. A false→true edge on `fetchStatus` catches a new request, and a term change while still fetching
	 * catches one that superseded a request in flight — the normal case whenever the store is slower than the debounce.
	 */
	const lastStart = useRef({ fetching: false, query: "" })
	useEffect(() => {
		const fetching = search.fetchStatus === "fetching"
		const previous = lastStart.current
		lastStart.current = { fetching, query: debouncedQuery }

		if (!active || !fetching) return
		if (previous.fetching && previous.query === debouncedQuery) return

		notify(() => listeners.current.onSearchStart?.(debouncedQuery))
	}, [active, debouncedQuery, listeners, search.fetchStatus])

	// Keyed on when the store answered, so one settled result reports once and a re-render does not repeat it.
	const reportedResults = useRef(0)
	useEffect(() => {
		if (!active || search.isPlaceholderData || search.status !== "success") return
		if (search.dataUpdatedAt === reportedResults.current) return

		reportedResults.current = search.dataUpdatedAt
		notify(() => listeners.current.onResults?.(products, debouncedQuery))
	}, [active, debouncedQuery, listeners, products, search.dataUpdatedAt, search.isPlaceholderData, search.status])

	const reportedError = useRef(0)
	useEffect(() => {
		if (!active || !search.isError || search.errorUpdatedAt === reportedError.current) return

		reportedError.current = search.errorUpdatedAt
		notify(() => listeners.current.onError?.(search.error, debouncedQuery))
	}, [active, debouncedQuery, listeners, search.error, search.errorUpdatedAt, search.isError])

	const setQuery = useCallback(
		(next: string) => {
			setQueryState(next)
			settleQuery(next)
			// Before the debounce on purpose: this is what opens a panel on the first keystroke instead of on the first result.
			notify(() => listeners.current.onQueryChange?.(next))
		},
		[listeners, settleQuery],
	)

	const clear = useCallback(() => {
		setQueryState("")
		// Replace a pending term and flush the empty value now, so closing the panel cannot leave a trailing request behind.
		settleQuery("")
		settleQuery.flush()
		notify(() => listeners.current.onClear?.())
	}, [listeners, settleQuery])

	const inputProps = useMemo(
		() => ({ onChange: (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value), value: query }),
		[query, setQuery],
	)

	return {
		clear,
		debouncedQuery,
		inputProps,
		isLoading,
		isRefreshing,
		products,
		query,
		// The live field, not the settled term: a shopper who submits mid-debounce means the term they typed.
		resultsHref: productSearchHref({ collectionPath, query }),
		setQuery,
		unavailable,
	}
}
