// @vitest-environment happy-dom

import { dehydrate, HydrationBoundary, keepPreviousData, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { parseAsString, useQueryState } from "nuqs"
import { NuqsTestingAdapter, type UrlUpdateEvent } from "nuqs/adapters/testing"
import { createElement, type ReactNode, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { type CollectionScope, parseCollectionQuery } from "../contract"
import { type LoadedProductCollection, productCollectionQueryKey } from "../request"
import type { ProductFilters, ProductList } from "../types"
import { ProductCollectionProvider } from "./client"
import { BrowserProductCollection, type BrowserProductCollectionProps, useProductCollection } from "./collection"
import { WooCommerceProvider } from "./provider"

const { procedures } = vi.hoisted(() => ({ procedures: { list: vi.fn(), filters: vi.fn() } }))
vi.mock("kizlo/react", () => ({ useKizloContext: () => ({ client: { woocommerce: { products: procedures } } }) }))

const currencyFormat = { currencyMinorUnit: 2, currencySymbol: "$" }
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
		cachedUpdatedAt?: number
	} = {},
) {
	const { initialData: seedData = initialData, cachedData, cachedError, cachedUpdatedAt, queryScope, ...config } = options
	const initialQuery = parseCollectionQuery(new URLSearchParams(searchParams))
	const queryClient = new QueryClient({
		defaultOptions: { queries: { staleTime: Infinity, retry: false, placeholderData: keepPreviousData } },
	})
	const category = new URLSearchParams(searchParams).get("category")
	const key = productCollectionQueryKey({
		...config,
		attributeTaxonomies: config.attributeTaxonomies ?? ["pa_color"],
		scope: queryScope && category ? { taxonomy: "product_cat", term: category } : (config.scope ?? undefined),
		query: initialQuery,
	})
	const serverCache = new QueryClient()
	serverCache.setQueryData(key, seedData, { updatedAt: 1000 })
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
	let changeCategory!: (value: string) => void
	function ScopedCollection({ children, ...props }: BrowserProductCollectionProps) {
		const [category, setCategory] = useQueryState("category", parseAsString)
		changeCategory = (value) => {
			void setCategory(value, { shallow: true, history: "push" })
		}
		return createElement(BrowserProductCollection, {
			...props,
			scope: queryScope && category ? { taxonomy: "product_cat", term: category } : props.scope,
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
			children: content,
		}
		const adapterProps = {
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
		snapshots,
		onUrlUpdate,
		change: (patch: Parameters<typeof change>[0]) => act(() => change(patch)),
		category: (value: string) => act(() => changeCategory(value)),
		...renderHook(
			() => {
				const model = useProductCollection()
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
		act(() => mounted.result.current.sort.set("newest"))
		await waitFor(() => expect(mounted.onUrlUpdate).toHaveBeenCalled())
		expect(mounted.onUrlUpdate.mock.lastCall?.[0]).toMatchObject({ options: { shallow: true, history: "push" } })
		expect(mounted.onUrlUpdate.mock.lastCall?.[0].searchParams.get("page")).toBeNull()
		expect(mounted.onUrlUpdate.mock.lastCall?.[0].searchParams.get("campaign")).toBe("summer")
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(2))
		act(() => mounted.result.current.products.setPage(2))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		expect(procedures.list.mock.lastCall?.[0].query.page).toBe(2)
		act(() => mounted.result.current.filters.search.set("tote"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(3))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ search: "tote", page: 1 })
		act(() => mounted.result.current.filters.clearAll())
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
		act(() => mounted.result.current.filters.search.set("old"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		expect(mounted.result.current.products.isPending).toBe(true)
		expect(mounted.result.current.products.items).toEqual([])
		act(() => mounted.result.current.filters.search.set("new"))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		await act(async () => {
			newListing.resolve({ success: true, data: listing(20) })
		})
		expect(mounted.result.current.products.items).toEqual([])
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
		act(() => mounted.result.current.filters.groups.find((group) => group.taxonomy === "pa_color")?.terms[0]?.toggle())
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(1))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ page: 1, stockStatus: ["instock"] })
		expect(procedures.list.mock.lastCall?.[0].query.attributes).toBeUndefined()
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(8))
		expect(mounted.result.current.products.items.map(({ id }) => id)).toEqual([8])
		act(() => mounted.result.current.filters.price.set(20, 70))
		await waitFor(() => expect(procedures.list).toHaveBeenCalledTimes(2))
		expect(procedures.list.mock.lastCall?.[0].query).toMatchObject({ page: 1, minPrice: "2000", maxPrice: "7000" })
		await waitFor(() => expect(mounted.result.current.products.isPending).toBe(false))
		act(() => mounted.result.current.filters.groups.find((group) => group.taxonomy === "stock")?.terms[0]?.toggle(false))
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
		act(() => mounted.result.current.filters.search.set("blue"))
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
		act(() => mounted.result.current.filters.search.set("failed"))
		await waitFor(() => expect(mounted.result.current.products.unavailable).toBe(true))
		expect(mounted.result.current.products.items).toEqual([])
		expect(mounted.result.current.products.isPending).toBe(false)
		act(() => mounted.result.current.filters.search.set("recovered"))
		await waitFor(() => expect(mounted.result.current.products.items[0]?.id).toBe(4))
		expect(mounted.result.current.products.unavailable).toBe(false)
		expect(mounted.result.current.filters.groups.find((group) => group.taxonomy === "stock")?.terms[0]?.count).toBe(1)
	})

	it("reports rejected transports without displaying another collection", async () => {
		procedures.list.mockRejectedValue(new Error("network unavailable"))
		procedures.filters.mockResolvedValue({ success: false })
		const mounted = mount()
		act(() => mounted.result.current.filters.search.set("offline"))
		await waitFor(() => expect(mounted.result.current.products.unavailable).toBe(true))
		expect(mounted.result.current.products.items).toEqual([])
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
	const { result } = renderHook(() => useProductCollection(), { wrapper })
	act(() => result.current.sort.set("newest"))
	await waitFor(() => expect(onUrlUpdate.mock.lastCall?.[0].options.shallow).toBe(false))
	expect(procedures.list).not.toHaveBeenCalled()
})
