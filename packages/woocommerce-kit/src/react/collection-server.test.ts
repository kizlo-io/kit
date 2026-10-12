import { dehydrate, HydrationBoundary, QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { NuqsTestingAdapter } from "nuqs/adapters/testing"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { expect, it, vi } from "vitest"
import { parseCollectionQuery } from "../contract"
import { emptyListing, productCollectionQueryKey } from "../request"
import { BrowserProductCollection, useProductCollection } from "./collection"
import { WooCommerceProvider } from "./provider"

const { list } = vi.hoisted(() => ({ list: vi.fn() }))
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
