"use client"

import { isServer, keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import { useKizloContext } from "kizlo/react"
import { createSerializer, parseAsString, useQueryStates } from "nuqs"
import { createContext, type MouseEvent, useContext, useRef, useState } from "react"
import { type CollectionActions, createCollectionActions } from "../collection-actions"
import {
	type CollectionQuery,
	type CollectionScopeQuery,
	collectionScopeHref,
	defaultNavigationTaxonomy,
	serializeCollectionQuery,
} from "../contract"
import { buildCollectionModel, type CollectionModel } from "../model"
import {
	emptyListing,
	type LoadedProductCollection,
	type LoadProductCollectionInput,
	loadProductCollection,
	loadProductCollectionPage,
	productCollectionQueryKey,
} from "../request"
import type { ProductList } from "../types"
import type { ProductCollectionProviderProps } from "./client"
import { ProductCollectionContext } from "./collection-context"
import { useWooCommerceContext } from "./context"
import { type IntersectionOptions, type InViewHookResponse, useInView } from "./in-view"
import { notify } from "./notify"
import { collectionSearchParams } from "./params"

export { collectionSearchParams } from "./params"
export type BrowserProductCollectionProps = Omit<
	ProductCollectionProviderProps,
	"filters" | "navigationTaxonomy" | "products" | "unavailable"
> &
	Omit<LoadProductCollectionInput, "client" | "query" | "scope"> & {
		initialQuery: CollectionQuery
		initialSearchParams?: string
		scopeQuery?: CollectionScopeQuery
	}
export type BrowserCollectionApi = CollectionModel &
	CollectionActions & {
		isLoading: boolean
		isRefreshing: boolean
		isPlaceholderData: boolean
		isLoadingMore: boolean
		hasMore: boolean
		error: Error | null
		loadMoreError: Error | null
		loadMore: () => Promise<void>
		refresh: () => Promise<void>
		setScope: (term: string | null) => void
		getScopeLinkProps: (term: string | null) => { href: string; onClick?: (event: MouseEvent<HTMLAnchorElement>) => void }
	}
const BrowserCollectionContext = createContext<{ value: BrowserCollectionApi; isWriting: boolean } | null>(null)

type Display = {
	data: LoadedProductCollection
	input: Omit<LoadProductCollectionInput, "client">
	key: ReturnType<typeof productCollectionQueryKey>
	identity: string
	revision: string
}

/** One page-scoped runtime, sharing the app's browser client and QueryClient. */
export function BrowserProductCollection({
	attributeTaxonomies,
	children,
	currencyMinorUnit,
	initialQuery,
	initialSearchParams,
	navigationTaxonomy,
	perPage,
	scope,
	scopeQuery,
	sortPresets,
	stockLabel,
	stockLabels,
}: BrowserProductCollectionProps) {
	const { client } = useKizloContext()
	const { queryClient, locale } = useWooCommerceContext()
	if (scopeQuery && (!scopeQuery.parameter || scopeQuery.parameter in collectionSearchParams))
		throw new Error("scopeQuery.parameter must name a separate application query parameter.")
	const parsers = scopeQuery ? { ...collectionSearchParams, [scopeQuery.parameter]: parseAsString.withDefault("") } : collectionSearchParams
	const [urlQuery, setQuery] = useQueryStates(parsers, { history: "push", shallow: true })
	const query: CollectionQuery = isServer ? initialQuery : (urlQuery as CollectionQuery)
	const scopeTerm = scopeQuery ? String(urlQuery[scopeQuery.parameter as keyof typeof urlQuery] ?? "") : ""
	const requestedScope =
		scopeQuery && !isServer ? (scopeTerm ? { taxonomy: scopeQuery.taxonomy, term: scopeTerm } : undefined) : (scope ?? undefined)
	const input = {
		attributeTaxonomies,
		currencyMinorUnit,
		perPage,
		query,
		scope: requestedScope,
		sortPresets,
		navigationTaxonomy: scopeQuery?.taxonomy ?? navigationTaxonomy,
	}
	const key = productCollectionQueryKey(input)
	const identity = JSON.stringify(key)
	const displayRef = useRef<Display | null>(null)
	const precision = useRef<number | undefined>(undefined)
	const first = useQuery(
		{
			enabled: !isServer,
			placeholderData: keepPreviousData,
			queryKey: key,
			queryFn: async () => {
				const data = await loadProductCollection({
					...input,
					client,
					currencyMinorUnit: currencyMinorUnit === "auto" ? (precision.current ?? "auto") : currencyMinorUnit,
				})
				if (data.unavailable) throw new Error("Product collection unavailable.")
				return data
			},
			refetchOnMount: false,
			refetchOnReconnect: false,
			refetchOnWindowFocus: false,
			retry: false,
			retryOnMount: false,
			staleTime: 0,
		},
		queryClient,
	)
	if (first.data && !first.isPlaceholderData && !first.data.unavailable && !first.isError) {
		displayRef.current = {
			data: first.data,
			input,
			key,
			identity,
			revision: `${first.dataUpdatedAt}:${queryClient.getQueryState(key)?.dataUpdateCount ?? 0}`,
		}
		precision.current =
			first.data.filters?.currencyFormat.currencyMinorUnit ??
			first.data.products.items[0]?.currencyFormat.currencyMinorUnit ??
			precision.current
	}
	// Placeholder timestamps are zero; only successful first batches change the append identity.
	const display = displayRef.current
	const base = display?.data ?? first.data
	const pages = useInfiniteQuery(
		{
			queryKey: [...(display?.key ?? key), "additional-pages", display?.revision ?? 0],
			placeholderData: () => undefined,
			enabled: false,
			initialPageParam: base?.products.meta.nextPage ?? query.page + 1,
			queryFn: ({ pageParam }) =>
				loadProductCollectionPage({
					...(display?.input ?? input),
					client,
					currencyMinorUnit: currencyMinorUnit === "auto" ? (precision.current ?? "auto") : currencyMinorUnit,
					query: { ...(display?.input.query ?? query), page: pageParam },
				}),
			getNextPageParam: (last: ProductList) => last.meta.nextPage ?? undefined,
			retry: false,
			staleTime: Infinity,
			refetchOnMount: false,
			refetchOnReconnect: false,
			refetchOnWindowFocus: false,
		},
		queryClient,
	)
	const additions = pages.data?.pages ?? []
	const lastPage = additions.at(-1) ?? base?.products
	const seen = new Set<number>()
	const items = [...(base?.products.items ?? []), ...additions.flatMap((page) => page.items)].filter((product) => {
		if (seen.has(product.id)) return false
		seen.add(product.id)
		return true
	})
	const retained = !!display && (display.identity !== identity || first.isError || first.data?.unavailable === true)
	const pending = first.isFetching || retained
	const model = buildCollectionModel({
		filters: base?.filters ?? null,
		isPending: first.isFetching,
		navigationTaxonomy: base?.navigationTaxonomy ?? input.navigationTaxonomy ?? requestedScope?.taxonomy ?? defaultNavigationTaxonomy,
		products: base ? { ...base.products, items, meta: lastPage?.meta ?? base.products.meta } : emptyListing(Math.max(1, query.page)),
		query,
		scope: requestedScope,
		sortPresets,
		stockLabel,
		stockLabels,
		unavailable: !display && (first.isError || base?.unavailable === true),
	})
	const hasMore = lastPage?.meta.hasNextPage === true
	const lock = useRef(false)
	const [isAppending, setAppending] = useState(false)
	const writing = useRef(0)
	const [isWriting, setWriting] = useState(false)
	function write(patch: Parameters<typeof setQuery>[0]) {
		writing.current += 1
		setWriting(true)
		void setQuery(patch).finally(() => {
			writing.current -= 1
			setWriting(writing.current > 0)
		})
	}
	async function loadMore() {
		if (
			!display ||
			pending ||
			first.isPending ||
			pages.isFetching ||
			lock.current ||
			writing.current ||
			queryClient.getQueryState(key)?.fetchStatus === "fetching" ||
			!hasMore ||
			lastPage?.meta.nextPage == null
		)
			return
		lock.current = true
		setAppending(true)
		try {
			await pages.fetchNextPage({ cancelRefetch: false })
		} finally {
			lock.current = false
			setAppending(false)
		}
	}
	function setScope(term: string | null) {
		if (!scopeQuery) throw new Error("Use application routing for pathname scopes, or configure scopeQuery.")
		write({ [scopeQuery.parameter]: term, page: null })
	}
	const value: BrowserCollectionApi = {
		...model,
		...createCollectionActions({ query, model, sortPresets, locale, write: (patch) => write(patch) }),
		isLoading: !base && first.isPending,
		isRefreshing: !!display && first.isFetching,
		isPlaceholderData: first.isPlaceholderData || retained,
		isLoadingMore: pages.isFetching || isAppending,
		hasMore,
		error: first.error ?? (first.data?.unavailable ? new Error("Product collection unavailable.") : null),
		loadMoreError: pages.error,
		loadMore,
		refresh: async () => {
			await first.refetch()
		},
		setScope,
		getScopeLinkProps: (term) => {
			if (!scopeQuery) throw new Error("Use application routing for pathname scopes, or configure scopeQuery.")
			return {
				href: collectionScopeHref(
					new URLSearchParams(
						createSerializer(parsers)(
							new URLSearchParams(isServer ? (initialSearchParams ?? serializeCollectionQuery(initialQuery)) : window.location.search),
							{ ...query, [scopeQuery.parameter]: term, page: null },
						),
					),
					scopeQuery,
					term,
				),
				onClick: (event) => {
					if (
						event.defaultPrevented ||
						event.button !== 0 ||
						event.metaKey ||
						event.ctrlKey ||
						event.shiftKey ||
						event.altKey ||
						event.currentTarget.hasAttribute("download") ||
						(event.currentTarget.target && event.currentTarget.target !== "_self")
					)
						return
					event.preventDefault()
					setScope(term)
				},
			}
		},
	}
	return (
		<ProductCollectionContext.Provider value={value}>
			<BrowserCollectionContext.Provider value={{ value, isWriting }}>{children}</BrowserCollectionContext.Provider>
		</ProductCollectionContext.Provider>
	)
}

export function useProductCollection({
	infiniteScroll,
}: {
	infiniteScroll?: IntersectionOptions
} = {}): BrowserCollectionApi & Pick<InViewHookResponse, "ref" | "inView" | "entry"> {
	const context = useContext(BrowserCollectionContext)
	if (!context)
		throw new Error("useProductCollection from react/collection needs <BrowserProductCollection> or the collection server wrapper.")
	const { value, isWriting } = context
	const visibility = useInView({
		...infiniteScroll,
		skip:
			!infiniteScroll ||
			infiniteScroll.skip ||
			isWriting ||
			value.isLoading ||
			value.isRefreshing ||
			value.isPlaceholderData ||
			value.isLoadingMore ||
			!!value.error ||
			!!value.loadMoreError ||
			!value.hasMore,
		onChange: (inView, entry) => {
			if (inView) void value.loadMore()
			if (infiniteScroll?.onChange) notify(() => infiniteScroll.onChange?.(inView, entry))
		},
	})
	return { ...value, ref: visibility.ref, inView: visibility.inView, entry: visibility.entry }
}
