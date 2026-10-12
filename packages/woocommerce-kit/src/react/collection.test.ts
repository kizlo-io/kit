// @vitest-environment happy-dom

import { dehydrate, HydrationBoundary, keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { debounce, parseAsString, useQueryState } from "nuqs"
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing"
import { createElement, Fragment, type ReactNode, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type CollectionScope, parseCollectionQuery } from "../contract"
import { type LoadedProductCollection, productCollectionQueryKey } from "../request"
import type { ProductFilters, ProductList } from "../types"
import { ProductCollectionProvider, useProductCollection as useServerCollection } from "./client"
import { BrowserProductCollection, type BrowserProductCollectionProps, useProductCollection } from "./collection"
import type { IntersectionOptions } from "./in-view"
import { WooCommerceProvider } from "./provider"

const { procedures } = vi.hoisted(() => ({ procedures: { list: vi.fn(), filters: vi.fn() } }))
vi.mock("kizlo/react", () => ({ useKizloContext: () => ({ client: { woocommerce: { products: procedures } } }) }))

const currencyFormat = { currencyCode: "USD", currencyMinorUnit: 2, currencySymbol: "$", currencyPrefix: "$", currencySuffix: "" }
function listing(id: number, page = 1): ProductList {
	return {
		items: [{ id, attributes: [], currencyFormat, isInStock: true, prices: { price: 1000 } }],
		meta: {
			page,
			totalItems: 5,
			totalPages: 5,
			hasNextPage: page < 5,
			hasPrevPage: page > 1,
			nextPage: page < 5 ? page + 1 : null,
			prevPage: page > 1 ? page - 1 : null,
		},
	} as unknown as ProductList
}
function facets(count = 5): ProductFilters {
	return {
		currencyFormat,
		priceRange: { minPrice: 1000, maxPrice: 10000 },
		attributeTerms: [{ id: 1, name: "Blue", slug: "blue", taxonomy: "pa_color", count }],
		stockStatuses: [{ status: "instock", count }],
		taxonomyTerms: [],
	} as unknown as ProductFilters
}
function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((done) => {
		resolve = done
	})
	return { promise, resolve }
}
const initialData: LoadedProductCollection = {
	products: listing(1),
	filters: facets(),
	navigationTaxonomy: "product_cat",
	unavailable: false,
}

function mount(
	searchParams = "",
	options: Partial<BrowserProductCollectionProps> & {
		initialData?: LoadedProductCollection
		queryScope?: boolean
		cachedData?: LoadedProductCollection
		cachedError?: boolean
		noSeed?: boolean
		infiniteScroll?: IntersectionOptions
		cachedUpdatedAt?: number
		adapterOptions?: Pick<Parameters<typeof NuqsTestingAdapter>[0], "defaultOptions" | "rateLimitFactor">
	} = {},
) {
	const {
		initialData: seedData = initialData,
		cachedData,
		cachedError,
		cachedUpdatedAt,
		queryScope,
		infiniteScroll,
		noSeed,
		adapterOptions,
		...config
	} = options
	const initialQuery = parseCollectionQuery(new URLSearchParams(searchParams))
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false, placeholderData: keepPreviousData } },
	})
	const category = new URLSearchParams(searchParams).get("category")
	const key = productCollectionQueryKey({
		...config,
		attributeTaxonomies: config.attributeTaxonomies ?? ["pa_color"],
		navigationTaxonomy: config.scopeQuery?.taxonomy ?? config.navigationTaxonomy,
		scope: (queryScope || config.scopeQuery) && category ? { taxonomy: "product_cat", term: category } : (config.scope ?? undefined),
		query: initialQuery,
	})
	const serverCache = new QueryClient()
	if (!noSeed) serverCache.setQueryData(key, seedData, { updatedAt: 1000 })
	const hydratedState = dehydrate(serverCache)
	serverCache.clear()
	if (cachedData) {
		queryClient.setQueryData(key, cachedData, { updatedAt: cachedUpdatedAt ?? 500 })
	}
	if (cachedError)
		queryClient
			.getQueryCache()
			.build(queryClient, { queryKey: key })
			.setState({ status: "error", error: new Error("old failure") })
	const snapshots: { ids: number[]; pending: boolean; unavailable: boolean }[] = []
	const onUrlUpdate = vi.fn<(event: UrlUpdateEvent) => void>()
	let change!: (patch: { searchParams?: string; scope?: CollectionScope | null; perPage?: number }) => void
	let sibling!: ReturnType<typeof useProductCollection>
	function Sibling() {
		sibling = useProductCollection()
		return null
	}
	let changeCategory!: (value: string) => void
	function ScopedCollection({ children, ...props }: BrowserProductCollectionProps) {
		const [category, setCategory] = useQueryState("category", parseAsString)
		changeCategory = (value) => {
			void setCategory(value, { shallow: true, history: "push" })
		}
		return createElement(BrowserProductCollection, {
			...props,
			navigationTaxonomy: config.scopeQuery?.taxonomy ?? config.navigationTaxonomy,
			scope: (queryScope || config.scopeQuery) && category ? { taxonomy: "product_cat", term: category } : props.scope,
			children,
		})
	}
	function Wrapper({ children: content }: { children: ReactNode }) {
		const [state, setState] = useState({ searchParams, scope: config.scope, perPage: config.perPage })
		change = (patch) => setState((current) => ({ ...current, ...patch }))
		const collectionProps = {
			attributeTaxonomies: ["pa_color"],
			...config,
			...state,
			initialQuery,
			children: createElement(Fragment, null, content, createElement(Sibling)),
		}
		const adapterProps = {
			...adapterOptions,
			searchParams: state.searchParams,
			hasMemory: true,
			onUrlUpdate: (event: Parameters<typeof onUrlUpdate>[0]) => {
				onUrlUpdate(event)
				setState((current) => ({ ...current, searchParams: event.queryString }))
			},
			children: createElement(HydrationBoundary, { state: hydratedState }, createElement(ScopedCollection, collectionProps)),
		}
		const children = createElement(NuqsTestingAdapter, adapterProps)
		return createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children }))
	}
	return {
		queryClient,
		sibling: () => sibling,
		snapshots,
		onUrlUpdate,
		change: (patch: Parameters<typeof change>[0]) => act(() => change(patch)),
		category: (value: string) => act(() => changeCategory(value)),
		...renderHook(
			() => {
				const model = useProductCollection({ infiniteScroll })
				snapshots.push({
					ids: model.products.items.map(({ id }) => id),
					pending: model.products.isPending,
					unavailable: model.products.unavailable,
				})
				return model
			},
			{ wrapper: Wrapper, reactStrictMode: true },
		),
	}
}

afterEach(() => {
	cleanup()
	vi.resetAllMocks()
})

describe("BrowserProductCollection", () => {
	it("hydrates a failed cache entry with no data without retrying on mount", async () => {
		const mounted = mount("?q=bag", { cachedError: true })
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(1))
		expect(mounted.result.current.products.unavailable).toBe(false)
		expect(procedures.list).not.toHaveBeenCalled()
		expect(procedures.filters).not.toHaveBeenCalled()
	})
	it("preserves newer browser cache data when the server snapshot is older", async () => {
		const mounted = mount("?q=bag", { cachedData: { ...initialData, products: listing(99) }, cachedUpdatedAt: 2000 })
		await act(async () => {})
		expect(mounted.result.current.products.items[0]?.id).toBe(99)
		expect(mounted.snapshots.every(({ ids }) => ids[0] === 99)).toBe(true)
		expect(
			mounted.queryClient.getQueryState(
				productCollectionQueryKey({ attributeTaxonomies: ["pa_color"], query: parseCollectionQuery({ q: "bag" }) }),
			)?.dataUpdatedAt,
		).toBe(2000)
		expect(procedures.list).not.toHaveBeenCalled()
	})
	it.each([false, true])("hydrates newer server data over older cached data (cached error: %s)", async (cachedError) => {
		const mounted = mount("?q=bag", { cachedData: { ...initialData, products: listing(99) }, cachedError })
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(1))
		expect(mounted.snapshots.length).toBeGreaterThan(0)
		expect(mounted.result.current.products.isPending).toBe(false)
		expect(mounted.result.current.products.unavailable).toBe(false)
		expect(
			mounted.queryClient.getQueryData(
				productCollectionQueryKey({ attributeTaxonomies: ["pa_color"], query: parseCollectionQuery({ q: "bag" }) }),
			),
		).toMatchObject({ products: { items: [{ id: 1 }] } })
		expect(
			mounted.queryClient.getQueryState(
				productCollectionQueryKey({ attributeTaxonomies: ["pa_color"], query: parseCollectionQuery({ q: "bag" }) }),
			)?.dataUpdatedAt,
		).toBe(1000)
		expect(procedures.list).not.toHaveBeenCalled()
	})
	it("reuses a filtered server seed and the app's cache without fetching on hydration", async () => {
		const mounted = mount("?attribute=pa_color:blue&q=bag&page=3", { initialData: { ...initialData, products: listing(3, 3) } })
		expect(mounted.result.current.products.items[0]?.id).toBe(3)
		expect(mounted.result.current.products.page).toBe(3)
		expect(mounted.result.current.filters.search.value).toBe("bag")
		expect(mounted.result.current.filters.groups.find((group) => group.taxonomy === "pa_color")?.terms[0]?.selected).toBe(true)
		expect(mounted.result.current.products.isPending).toBe(false)
		await act(async () => {})
		expect(procedures.list).not.toHaveBeenCalled()
		expect(procedures.filters).not.toHaveBeenCalled()
		expect(
			mounted.queryClient.getQueryData(
				productCollectionQueryKey({
					attributeTaxonomies: ["pa_color"],
					query: parseCollectionQuery(new URLSearchParams("attribute=pa_color:blue&q=bag&page=3")),
				}),
			),
		).toMatchObject({ products: { meta: { page: 3 } } })
	})

	it("writes shallow history, resets paging, clears filters, and refreshes cached visits", async () => {
		procedures.list.mockImplementation(({ query }) => Promise.resolve({ success: true, data: listing(2, query.page) }))
		procedures.filters.mockResolvedValue({ success: true, data: facets(2) })
		const mounted = mount("?q=bag&page=3&campaign=summer", { initialData: { ...initialData, products: listing(1, 3) } })
		act(() => mounted.result.current.setSort("newest"))
		await waitFor(() => expect(mounted.onUrlUpdate).toHaveBeenCalled())
		expect(mounted.onUrlUpdate.mock.lastCall?.[0]).toMatchObject({ options: { shallow: true, history: "push" } })
		expect(mounted.onUrlUpdate.mock.lastCall?.[0].searchParams.get("page")).toBeNull()
		expect(mounted.onUrlUpdate.mock.lastCall?.[0].searchParams.get("campaign")).toBe("summer")
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(2))
		act(() => mounted.result.current.setPage(2))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		expect(procedures.list.mock.lastCall?.[0].query.page).toBe(2)
		act(() => mounted.result.current.setSearch("tote"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(3))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ search: "tote", page: 1 })
		act(() => mounted.result.current.clearFilters())
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(4))
		expect(procedures.list.mock.lastCall?.[0].query.search).toBeUndefined()
		mounted.change({ searchParams: "?q=bag&page=3&campaign=summer" })
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(5))
		expect(mounted.result.current.filters.search.value).toBe("bag")
		mounted.change({ searchParams: "?q=tote&sort=newest&campaign=summer" })
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(6))
		expect(mounted.result.current.filters.search.value).toBe("tote")
	})

	it("keeps products and facet counts together and caches late responses under their own query", async () => {
		const oldListing = deferred<{ success: true; data: ProductList }>(),
			oldFacets = deferred<{ success: true; data: ProductFilters }>()
		const newListing = deferred<{ success: true; data: ProductList }>(),
			newFacets = deferred<{ success: true; data: ProductFilters }>()
		procedures.list.mockReturnValueOnce(oldListing.promise).mockReturnValueOnce(newListing.promise)
		procedures.filters.mockReturnValueOnce(oldFacets.promise).mockReturnValueOnce(newFacets.promise)
		const mounted = mount()
		act(() => mounted.result.current.setSearch("old"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		expect(mounted.result.current.products.isPending).toBe(true)
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1])
		act(() => mounted.result.current.setSearch("new"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		await act(async () => {
			newListing.resolve({ success: true, data: listing(20) })
		})
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1])
		await act(async () => {
			newFacets.resolve({ success: true, data: facets(20) })
		})
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(20))
		expect(mounted.result.current.filters.groups[0]?.terms[0]?.count).toBe(20)
		await act(async () => {
			oldListing.resolve({ success: true, data: listing(10) })
			oldFacets.resolve({ success: true, data: facets(10) })
		})
		expect(mounted.result.current.products.items[0]?.id).toBe(20)
		expect(mounted.result.current.filters.search.value).toBe("new")
		expect(
			mounted.queryClient.getQueryData(
				productCollectionQueryKey({ attributeTaxonomies: ["pa_color"], query: { ...parseCollectionQuery({}), q: "old" } }),
			),
		).toMatchObject({ products: { items: [{ id: 10 }] } })
	})

	it("resets pages when toggling attribute/stock filters and changing the price range", async () => {
		procedures.list.mockImplementation(({ query }) => Promise.resolve({ success: true, data: listing(8, query.page) }))
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		const mounted = mount("?attribute=pa_color:blue&stock=instock&page=3", { initialData: { ...initialData, products: listing(3, 3) } })
		act(() => mounted.result.current.toggleAttribute("pa_color:blue"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ page: 1, stockStatus: ["instock"] })
		expect(procedures.list.mock.lastCall?.[0].query.attributes).toBeUndefined()
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(8))
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([8])
		act(() => mounted.result.current.setPriceRange(20, 70))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ page: 1, minPrice: "2000", maxPrice: "7000" })
		await waitFor(() => expect(mounted.result.current.products.isPending).toBe(false))
		act(() => mounted.result.current.toggleStock("instock", false))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(3))
		expect(procedures.list.mock.lastCall?.[0].query.stockStatus).toBeUndefined()
	})

	it("fetches reactive scope/configuration changes without reusing a seed from the old scope", async () => {
		procedures.list.mockResolvedValue({ success: true, data: listing(9) })
		procedures.filters.mockResolvedValue({ success: true, data: facets(9) })
		const mounted = mount("", { scope: { taxonomy: "product_cat", term: "bags" } })
		mounted.change({ scope: { taxonomy: "product_brand", term: "nike" }, perPage: 24 })
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ brand: "nike", perPage: 24 })
		expect(procedures.filters.mock.lastCall?.[0].query.taxonomyCounts).toEqual(["product_brand"])
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(9))
	})

	it("reads category scope from another URL parameter and keeps it on collection writes", async () => {
		procedures.list.mockResolvedValue({ success: true, data: listing(9) })
		procedures.filters.mockResolvedValue({ success: true, data: facets(9) })
		const mounted = mount("?category=bags", { queryScope: true })
		mounted.category("shoes")
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		expect(procedures.list.mock.lastCall?.[0].query.category).toBe("shoes")
		act(() => mounted.result.current.setSearch("blue"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ category: "shoes", search: "blue" })
		await waitFor(() => expect(mounted.onUrlUpdate.mock.lastCall?.[0].searchParams.get("category")).toBe("shoes"))
		mounted.change({ searchParams: "?category=bags" })
		await waitFor(() => expect(procedures.list.mock.lastCall?.[0].query.category).toBe("bags"))
	})

	it("fails soft for listing/facet failures and recovers on the next selection", async () => {
		procedures.list.mockResolvedValueOnce({ success: false }).mockResolvedValue({ success: true, data: listing(4) })
		procedures.filters.mockResolvedValueOnce({ success: true, data: facets(8) }).mockResolvedValue({ success: false })
		const mounted = mount()
		act(() => mounted.result.current.setSearch("failed"))
		await waitFor(() => expect(mounted.result.current.error).not.toBeNull())
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1])
		expect(mounted.result.current.products.isPending).toBe(false)
		act(() => mounted.result.current.setSearch("recovered"))
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(4))
		expect(mounted.result.current.products.unavailable).toBe(false)
		expect(mounted.result.current.filters.groups.find((group) => group.taxonomy === "stock")?.terms[0]?.count).toBe(1)
	})

	it("retains the last collection after rejected transports", async () => {
		procedures.list.mockRejectedValue(new Error("network unavailable"))
		procedures.filters.mockResolvedValue({ success: false })
		const mounted = mount()
		act(() => mounted.result.current.setSearch("offline"))
		await waitFor(() => expect(mounted.result.current.error).not.toBeNull())
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1])
		expect(mounted.result.current.products.isPending).toBe(false)
	})
})

it("preserves the server-navigation provider without query providers", async () => {
	const onUrlUpdate = vi.fn()
	const wrapper = ({ children }: { children: ReactNode }) => {
		const props = {
			hasMemory: true,
			onUrlUpdate,
			children: createElement(ProductCollectionProvider, { ...initialData, children }),
		}
		return createElement(NuqsTestingAdapter, props)
	}
	const { result } = renderHook(() => useServerCollection(), { wrapper })
	act(() => result.current.setSort("newest"))
	await waitFor(() => expect(onUrlUpdate.mock.lastCall?.[0].options.shallow).toBe(false))
	expect(procedures.list).not.toHaveBeenCalled()
})

describe("accumulated collection continuity", () => {
	it("retains every appended page and facets until matching replacement results arrive", async () => {
		procedures.list.mockImplementation(({ query }) => Promise.resolve({ success: true, data: listing(query.page, query.page) }))
		const mounted = mount()
		await act(async () => {
			await mounted.result.current.loadMore()
			await mounted.result.current.loadMore()
		})
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2, 3]))
		expect(procedures.filters).not.toHaveBeenCalled()
		const nextProducts = deferred<{ success: true; data: ProductList }>(),
			nextFilters = deferred<{ success: true; data: ProductFilters }>()
		procedures.list.mockReturnValueOnce(nextProducts.promise)
		procedures.filters.mockReturnValueOnce(nextFilters.promise)
		act(() => mounted.result.current.setSearch("new"))
		await waitFor(() => expect(mounted.result.current.isRefreshing).toBe(true))
		expect(mounted.result.current.isPlaceholderData).toBe(true)
		expect(mounted.result.current.filters.search.value).toBe("new")
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2, 3])
		await act(async () => {
			await mounted.result.current.loadMore()
			nextProducts.resolve({ success: true, data: listing(20) })
		})
		expect(procedures.list).toHaveBeenCalledTimes(3)
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2, 3])
		expect(mounted.result.current.filters.groups[0]?.terms[0]?.count).toBe(5)
		await act(async () => nextFilters.resolve({ success: true, data: facets(20) }))
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([20]))
		expect(mounted.result.current.isPlaceholderData).toBe(false)
		expect(mounted.result.current.filters.groups[0]?.terms[0]?.count).toBe(20)
	})
	it("deduplicates IDs, guards concurrent appends, preserves failed pages and retries the same next page", async () => {
		const next = deferred<{ success: true; data: ProductList }>()
		procedures.list.mockReturnValueOnce(next.promise)
		const mounted = mount()
		let first!: Promise<void>
		act(() => {
			first = mounted.result.current.loadMore()
			void mounted.sibling().loadMore()
		})
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		const secondPage = listing(2, 2)
		secondPage.items.push(...listing(1).items, ...listing(2).items)
		await act(async () => {
			next.resolve({ success: true, data: secondPage })
			await first
		})
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2]))
		procedures.list.mockResolvedValueOnce({ success: false })
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		await waitFor(() => expect(mounted.result.current.loadMoreError).not.toBeNull())
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2])
		expect(procedures.list.mock.lastCall?.[0].query.page).toBe(3)
		procedures.list.mockResolvedValueOnce({ success: true, data: listing(3, 3) })
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2, 3]))
		expect(procedures.list.mock.lastCall?.[0].query.page).toBe(3)
		expect(procedures.filters).not.toHaveBeenCalled()
	})
	it("retains appended results after a failed new selection, then replaces them on retry", async () => {
		procedures.list.mockResolvedValueOnce({ success: true, data: listing(2, 2) })
		const mounted = mount()
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		await waitFor(() => expect(mounted.result.current.products.items).toHaveLength(2))
		procedures.list.mockResolvedValueOnce({ success: false })
		procedures.filters.mockResolvedValue({ success: true, data: facets(8) })
		act(() => mounted.result.current.setSort("newest"))
		await waitFor(() => expect(mounted.result.current.error).not.toBeNull())
		expect(mounted.result.current.isRefreshing).toBe(false)
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2])
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		expect(procedures.list).toHaveBeenCalledTimes(2)
		procedures.list.mockResolvedValueOnce({ success: true, data: listing(9) })
		await act(async () => {
			await mounted.result.current.refresh()
		})
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([9]))
		expect(mounted.result.current.error).toBeNull()
	})
	it("retains pages for a same-key refresh and resets them only after success", async () => {
		procedures.list.mockResolvedValueOnce({ success: true, data: listing(2, 2) })
		const mounted = mount()
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		await waitFor(() => expect(mounted.result.current.products.items).toHaveLength(2))
		const replacement = deferred<{ success: true; data: ProductList }>()
		procedures.list.mockReturnValueOnce(replacement.promise)
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		let refresh!: Promise<void>
		act(() => {
			refresh = mounted.result.current.refresh()
		})
		await waitFor(() => expect(mounted.result.current.isRefreshing).toBe(true))
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2])
		await act(async () => {
			replacement.resolve({ success: true, data: listing(9) })
			await refresh
		})
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([9]))
	})
	it("never mixes a late appended response into another selection and stops at the end", async () => {
		const late = deferred<{ success: true; data: ProductList }>()
		procedures.list.mockReturnValueOnce(late.promise).mockResolvedValueOnce({ success: true, data: listing(10, 5) })
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		const mounted = mount()
		let append!: Promise<void>
		act(() => {
			append = mounted.result.current.loadMore()
		})
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		act(() => mounted.result.current.setSearch("different"))
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([10]))
		await act(async () => {
			late.resolve({ success: true, data: listing(2, 2) })
			await append
		})
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([10])
		expect(mounted.result.current.hasMore).toBe(false)
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		expect(procedures.list).toHaveBeenCalledTimes(2)
	})
	it("reports an initial failure without retrying hydration, and recovers explicitly", async () => {
		const mounted = mount("", { initialData: { ...initialData, unavailable: true, products: { ...listing(0), items: [] }, filters: null } })
		expect(mounted.result.current.products.unavailable).toBe(true)
		expect(mounted.result.current.isLoading).toBe(false)
		expect(mounted.result.current.products.items).toEqual([])
		expect(procedures.list).not.toHaveBeenCalled()
		procedures.list.mockResolvedValue({ success: true, data: listing(2) })
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		await act(async () => {
			await mounted.result.current.refresh()
		})
		await waitFor(() => expect(mounted.result.current.products.unavailable).toBe(false))
	})
	it("observes only nested infinite options and isolates throwing visibility callbacks", async () => {
		const callbacks: ((entries: IntersectionObserverEntry[]) => void)[] = []
		vi.stubGlobal(
			"IntersectionObserver",
			class {
				observe = vi.fn()
				disconnect = vi.fn()
				constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
					callbacks.push(callback)
				}
			},
		)
		const errors: (() => void)[] = []
		const microtask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((callback) => {
			errors.push(callback)
		})
		try {
			procedures.list.mockResolvedValue({ success: true, data: listing(2, 5) })
			const callback = vi.fn(() => {
				throw new Error("listener")
			})
			const mounted = mount("", { infiniteScroll: { rootMargin: "200px", onChange: callback } })
			const target = document.createElement("div")
			act(() => mounted.result.current.ref(target))
			act(() => callbacks.at(-1)?.([{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry]))
			await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([1, 2]))
			expect(callback).toHaveBeenCalledWith(true, expect.objectContaining({ target }))
			expect(errors).toHaveLength(1)
			expect(errors[0]).toThrow("listener")
		} finally {
			microtask.mockRestore()
			vi.unstubAllGlobals()
		}
	})
})

it("uses configured scope actions and retains native link behaviors", async () => {
	const original = window.location.href
	window.history.replaceState(null, "", "/collections?category=bags&campaign=summer&attribute=pa_color:blue&attribute=pa_size:l&page=3")
	try {
		procedures.list.mockResolvedValue({ success: true, data: listing(9) })
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		const mounted = mount("?category=bags&campaign=summer&attribute=pa_color:blue&attribute=pa_size:l&page=3", {
			scopeQuery: { taxonomy: "product_cat", parameter: "category" },
		})
		const link = mounted.result.current.getScopeLinkProps("shoes")
		const params = new URLSearchParams(link.href)
		expect(params.get("category")).toBe("shoes")
		expect(params.get("page")).toBeNull()
		expect(params.get("campaign")).toBe("summer")
		expect(params.getAll("attribute")).toEqual(["pa_color:blue", "pa_size:l"])
		const anchor = document.createElement("a")
		const preventDefault = vi.fn()
		const event = { currentTarget: anchor, button: 0, preventDefault, defaultPrevented: false }
		for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"])
			link.onClick?.({ ...event, [modifier]: true } as unknown as Parameters<NonNullable<typeof link.onClick>>[0])
		anchor.target = "_blank"
		link.onClick?.(event as unknown as Parameters<NonNullable<typeof link.onClick>>[0])
		anchor.target = ""
		link.onClick?.({ ...event, button: 1 } as unknown as Parameters<NonNullable<typeof link.onClick>>[0])
		expect(preventDefault).not.toHaveBeenCalled()
		act(() => link.onClick?.(event as unknown as Parameters<NonNullable<typeof link.onClick>>[0]))
		await waitFor(() => expect(procedures.list.mock.lastCall?.[0].query.category).toBe("shoes"))
		expect(preventDefault).toHaveBeenCalledOnce()
		expect(mounted.onUrlUpdate.mock.lastCall?.[0]).toMatchObject({ options: { shallow: true, history: "push" } })
		expect(mounted.onUrlUpdate.mock.lastCall?.[0].searchParams.get("campaign")).toBe("summer")
		await waitFor(() => expect(mounted.result.current.isRefreshing).toBe(false))
		mounted.change({ searchParams: "?category=bags&campaign=summer&attribute=pa_color:blue&attribute=pa_size:l&page=3" })
		await waitFor(() => expect(procedures.list.mock.lastCall?.[0].query.category).toBe("bags"))
	} finally {
		window.history.replaceState(null, "", original)
	}
})

it.each([0, 2, 3])("reuses hydrated %i-decimal precision for browser price changes", async (minorUnit) => {
	const data = {
		...initialData,
		filters: {
			...facets(),
			priceRange: { minPrice: 10 * 10 ** minorUnit, maxPrice: 100 * 10 ** minorUnit },
			currencyFormat: { ...currencyFormat, currencyMinorUnit: minorUnit },
		},
	} as LoadedProductCollection
	const mounted = mount("", { initialData: data, currencyMinorUnit: "auto" })
	procedures.list.mockResolvedValue({ success: true, data: listing(8) })
	procedures.filters.mockResolvedValue({ success: true, data: facets() })
	act(() => mounted.result.current.setPriceRange(20, 70))
	await waitFor(() => expect(procedures.list).toHaveBeenCalledOnce())
	expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({
		minPrice: String(20 * 10 ** minorUnit),
		maxPrice: String(70 * 10 ** minorUnit),
	})
	expect(procedures.filters).toHaveBeenCalledOnce()
})

it("separates initial loading from a terminal initial failure", async () => {
	const first = deferred<{ success: false }>()
	procedures.list.mockReturnValue(first.promise)
	procedures.filters.mockResolvedValue({ success: false })
	const mounted = mount("", { noSeed: true })
	expect(mounted.result.current.isLoading).toBe(true)
	expect(mounted.result.current.isRefreshing).toBe(false)
	await act(async () => first.resolve({ success: false }))
	await waitFor(() => expect(mounted.result.current.products.unavailable).toBe(true))
	expect(mounted.result.current.isLoading).toBe(false)
	expect(mounted.result.current.products.items).toEqual([])
})

it("blocks appending synchronously when another consumer requests a selection or refresh", async () => {
	const replacement = deferred<{ success: true; data: ProductList }>()
	procedures.list.mockReturnValue(replacement.promise)
	procedures.filters.mockResolvedValue({ success: true, data: facets() })
	const mounted = mount()
	act(() => {
		mounted.result.current.setSort("newest")
		void mounted.sibling().loadMore()
	})
	await waitFor(() => expect(procedures.list).toHaveBeenCalledOnce())
	expect(procedures.list.mock.lastCall?.[0].query.page).toBe(1)
	await act(async () => replacement.resolve({ success: true, data: listing(10) }))
	await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(10))
	const refresh = deferred<{ success: true; data: ProductList }>()
	procedures.list.mockReturnValue(refresh.promise)
	act(() => {
		void mounted.result.current.refresh()
		void mounted.sibling().loadMore()
	})
	expect(procedures.list).toHaveBeenCalledTimes(2)
	await act(async () => refresh.resolve({ success: true, data: listing(20) }))
})

it("resets appended pages after a same-key success even when timestamps are identical", async () => {
	const timestamp = vi.spyOn(Date, "now").mockReturnValue(1000)
	try {
		procedures.list.mockResolvedValueOnce({ success: true, data: listing(2, 2) }).mockResolvedValueOnce({ success: true, data: listing(9) })
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		const mounted = mount()
		await act(async () => {
			await mounted.result.current.loadMore()
		})
		await waitFor(() => expect(mounted.result.current.products.items).toHaveLength(2))
		await act(async () => {
			await mounted.result.current.refresh()
		})
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([9]))
	} finally {
		timestamp.mockRestore()
	}
})

it("resumes automatic loading after a previous selection's append finishes", async () => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			callback: (entries: IntersectionObserverEntry[]) => void
			constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
				this.callback = callback
			}
			observe(target: Element) {
				queueMicrotask(() =>
					this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry]),
				)
			}
			disconnect = vi.fn()
		},
	)
	try {
		const late = deferred<{ success: true; data: ProductList }>()
		procedures.list
			.mockReturnValueOnce(late.promise)
			.mockResolvedValueOnce({ success: true, data: listing(10) })
			.mockResolvedValueOnce({ success: true, data: listing(11, 5) })
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		const mounted = mount("", { infiniteScroll: {} })
		act(() => mounted.result.current.ref(document.createElement("div")))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledOnce())
		act(() => mounted.result.current.setSearch("new"))
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(10))
		expect(mounted.result.current.isLoadingMore).toBe(true)
		expect(procedures.list).toHaveBeenCalledTimes(2)
		await act(async () => late.resolve({ success: true, data: listing(2, 2) }))
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([10, 11]))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ search: "new", page: 2 })
	} finally {
		vi.unstubAllGlobals()
	}
})

it.each(["debounce", "default throttle"])("resumes automatic loading after a fast replacement and delayed URL write (%s)", async (mode) => {
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			callback: (entries: IntersectionObserverEntry[]) => void
			constructor(callback: (entries: IntersectionObserverEntry[]) => void) {
				this.callback = callback
			}
			observe(target: Element) {
				queueMicrotask(() => this.callback([{ target, isIntersecting: true, intersectionRatio: 1 } as IntersectionObserverEntry]))
			}
			disconnect = vi.fn()
		},
	)
	try {
		procedures.list.mockImplementation(({ query }) =>
			Promise.resolve({ success: true, data: listing(query.search ? (query.page === 1 ? 10 : 11) : 20, query.page === 1 ? 1 : 5) }),
		)
		procedures.filters.mockResolvedValue({ success: true, data: facets() })
		const mounted = mount("", {
			infiniteScroll: {},
			adapterOptions: { rateLimitFactor: 1, defaultOptions: mode === "debounce" ? { limitUrlUpdates: debounce(150) } : {} },
		})
		act(() => mounted.result.current.setSort("newest"))
		await waitFor(() => expect(mounted.onUrlUpdate).toHaveBeenCalledOnce(), { interval: 1 })
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(20), { interval: 1 })
		act(() => {
			mounted.result.current.ref(document.createElement("div"))
			mounted.result.current.setSearch("pending")
			mounted.result.current.setSearch("quick")
		})
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(10), { interval: 1 })
		await waitFor(() => expect(mounted.onUrlUpdate).toHaveBeenCalledTimes(2), { interval: 1 })
		await waitFor(() => expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([10, 11]))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ search: "quick", page: 2 })
	} finally {
		vi.unstubAllGlobals()
	}
})
