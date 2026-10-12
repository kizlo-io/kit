import { dehydrate, HydrationBoundary, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ActiveKizloClient } from "kizlo"
import { NuqsTestingAdapter } from "nuqs/adapters/testing"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, expect, it, vi } from "vitest"
import { parseCollectionQuery } from "../contract"
import { emptyListing, productCollectionQueryKey } from "../request"
import { BrowserProductCollection, useProductCollection } from "./collection"
import { ProductCollection } from "./collection-server"
import { WooCommerceProvider } from "./provider"

const { list, filters } = vi.hoisted(() => ({ list: vi.fn(), filters: vi.fn() }))
vi.mock("kizlo/react", () => ({ useKizloContext: () => ({ client: { woocommerce: { products: { list } } } }) }))

it("renders the server's parsed deep link even when the URL adapter has no server search params", () => {
	const queryClient = new QueryClient()
	const initialQuery = parseCollectionQuery({ q: "bags", page: "3", sort: "newest" })
	const serverCache = new QueryClient()
	serverCache.setQueryData(productCollectionQueryKey({ attributeTaxonomies: [], query: initialQuery }), {
		filters: null,
		navigationTaxonomy: "product_cat",
		products: emptyListing(3),
		unavailable: false,
	})
	const state = dehydrate(serverCache)
	serverCache.clear()
	function Selection() {
		const { filters, products, sort } = useProductCollection()
		return createElement("output", null, `${filters.search.value}:${products.page}:${sort.value}:${products.isPending}`)
	}
	const props = {
		attributeTaxonomies: [],
		initialQuery,
		children: createElement(Selection),
	}
	const adapterProps = { children: createElement(HydrationBoundary, { state }, createElement(BrowserProductCollection, props)) }
	const children = createElement(NuqsTestingAdapter, adapterProps)
	const html = renderToString(createElement(QueryClientProvider, { client: queryClient }, createElement(WooCommerceProvider, { children })))
	expect(html).toContain("bags:3:newest:false")
	expect(list).not.toHaveBeenCalled()
	queryClient.clear()
})

afterEach(() => vi.resetAllMocks())

it.each([false, true])("initializes full URL links and native cache data (URLSearchParams: %s)", async (useParams) => {
	list.mockResolvedValue({ success: true, data: emptyListing(3) })
	filters.mockResolvedValue({ success: false })
	const client = { secret: "server-credential", woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
	function Selection() {
		const { filters: facets, products, getScopeLinkProps } = useProductCollection()
		return createElement("a", { ...getScopeLinkProps("shoes") }, `${facets.search.value}:${products.page}`)
	}
	const params = { category: "bags", page: "3", attribute: ["pa_color:blue", "pa_size:l"], campaign: "summer", q: "blue" }
	const component = await ProductCollection({
		client,
		attributeTaxonomies: [],
		searchParams: Promise.resolve(
			useParams
				? new URLSearchParams(
						Object.entries(params).flatMap(([name, value]) => (Array.isArray(value) ? value : [value]).map((item) => [name, item])),
					)
				: params,
		),
		scopeQuery: { taxonomy: "product_cat", parameter: "category" },
		children: createElement(Selection),
	})
	expect(list).toHaveBeenCalledOnce()
	expect(filters).toHaveBeenCalledOnce()
	expect(list.mock.lastCall?.[0].query).toMatchObject({ category: "bags", search: "blue", page: 3 })
	expect(component.props.state.queries[0].state.dataUpdatedAt).toBeGreaterThan(0)
	expect(JSON.stringify(component.props)).not.toContain("server-credential")
	const cache = new QueryClient()
	const adapterProps = { children: component }
	const children = createElement(NuqsTestingAdapter, adapterProps)
	const html = renderToString(createElement(QueryClientProvider, { client: cache }, createElement(WooCommerceProvider, { children })))
	expect(html).toContain("blue:3")
	const link = new URLSearchParams(html.match(/href="([^"]*)"/)?.[1]?.replaceAll("&amp;", "&"))
	expect(link.get("q")).toBe("blue")
	expect(link.get("campaign")).toBe("summer")
	expect(link.get("category")).toBe("shoes")
	expect(link.getAll("attribute")).toEqual(["pa_color:blue", "pa_size:l"])
	expect(link.get("page")).toBeNull()
	expect(list).toHaveBeenCalledOnce()
	cache.clear()
})

it("dehydrates initial transport failures as unavailable without serializing errors", async () => {
	list.mockRejectedValue(new Error("private transport detail"))
	filters.mockResolvedValue({ success: false })
	const client = { woocommerce: { products: { list, filters } } } as unknown as ActiveKizloClient
	const component = await ProductCollection({ client, attributeTaxonomies: [], searchParams: {}, children: null })
	expect(component.props.state.queries[0].state.data.unavailable).toBe(true)
	expect(JSON.stringify(component.props.state)).not.toContain("private transport detail")
})
