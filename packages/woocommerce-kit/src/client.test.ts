/**
 * The kit's types, checked against the WooCommerce contract rather than against a description of it.
 *
 * Type-level only — every assertion takes its subject as a type argument, so nothing is dereferenced at runtime and `pnpm test`
 * has nothing to execute. `pnpm typecheck` is what enforces this file, because `tsconfig.json` includes both `src/**` and the
 * registry fill in `types/`. It is the regression for the hand-written types this package used to import: if a procedure the kit
 * calls is renamed or retyped upstream, its derived alias collapses to `never` and these assertions stop compiling instead of
 * the drift surfacing in a storefront.
 */

import type { ActiveKizloClient } from "kizlo"
import { describe, expectTypeOf, it } from "vitest"
import type {
	AddCartItemInput,
	Cart,
	CartError,
	CartItem,
	Checkout,
	CheckoutError,
	ConfirmCheckoutInput,
	ListProductInput,
	Product,
	ProductFilters,
	ProductList,
	ProductOrderBy,
	Storefront,
	UpdateCartInput,
} from "./types"

type CartProcedures = ActiveKizloClient["woocommerce"]["cart"]
type ProductProcedures = ActiveKizloClient["woocommerce"]["products"]

describe("the registered Kizlo client", () => {
	it("answers the cart procedures the cart hooks call", () => {
		expectTypeOf<CartProcedures["get"]>().toBeCallableWith()
		expectTypeOf<CartProcedures["items"]["add"]>().toBeCallableWith({ body: { productId: 1 } })
		expectTypeOf<CartProcedures["items"]["remove"]>().toBeCallableWith({ params: { key: "abc" } })
		expectTypeOf<CartProcedures["coupons"]["apply"]>().toBeCallableWith({ body: { code: "SAVE10" } })
		expectTypeOf<CartProcedures["selectShippingRate"]>().toBeCallableWith({ body: { rateId: "flat_rate:1" } })
	})

	it("answers the product procedures the collection and the typeahead call", () => {
		expectTypeOf<ProductProcedures["list"]>().toBeCallableWith({ query: { page: 1 } })
		expectTypeOf<ProductProcedures["filters"]>().toBeCallableWith({ query: { stockStatusCounts: true } })
	})

	it("answers the storefront procedure the settings hook calls", () => {
		expectTypeOf<ActiveKizloClient["woocommerce"]["storefront"]["get"]>().toBeCallableWith()
	})

	it("carries only the integrations this repo registers", () => {
		expectTypeOf<"shopify">().not.toExtend<keyof ActiveKizloClient>()
	})
})

/**
 * A derived alias that names a procedure the contract does not have resolves to `never`, and `never` is assignable to
 * everything — so a structural assertion alone would pass on a broken derivation. These are what catch that.
 */
describe("the derived types", () => {
	it("resolve against the contract rather than collapsing", () => {
		expectTypeOf<Cart>().not.toBeNever()
		expectTypeOf<CartItem>().not.toBeNever()
		expectTypeOf<Checkout>().not.toBeNever()
		expectTypeOf<Product>().not.toBeNever()
		expectTypeOf<ProductList>().not.toBeNever()
		expectTypeOf<ProductFilters>().not.toBeNever()
		expectTypeOf<AddCartItemInput>().not.toBeNever()
		expectTypeOf<UpdateCartInput>().not.toBeNever()
		expectTypeOf<ConfirmCheckoutInput>().not.toBeNever()
		expectTypeOf<ListProductInput>().not.toBeNever()
		expectTypeOf<ProductOrderBy>().not.toBeNever()
		expectTypeOf<Storefront>().not.toBeNever()
	})

	it("carry the fields the kit reads off a cart", () => {
		expectTypeOf<Cart>().toExtend<{ itemCount: number; items: readonly CartItem[] }>()
		expectTypeOf<CartItem>().toExtend<{ isSoldIndividually: boolean; key: string; quantity: number }>()
		expectTypeOf<CartItem["quantityLimits"]>().toExtend<{ editable: boolean; maximum: number; minimum: number; multipleOf: number }>()
	})

	it("carry the fields the kit reads off a listing", () => {
		expectTypeOf<ProductList>().toExtend<{ items: readonly Product[] }>()
		expectTypeOf<ProductList["meta"]>().toExtend<{ page: number; totalPages: number }>()
	})

	it("carry the address data the kit derives from", () => {
		expectTypeOf<Storefront["address"]["countries"][number]>().toExtend<{
			allowShipping: boolean
			code: string
			states: readonly { code: string }[]
		}>()
		expectTypeOf<Storefront["address"]["fieldLocations"]>().toExtend<{ address: readonly string[] }>()
	})

	it("accept what the kit sends", () => {
		expectTypeOf<AddCartItemInput>().toExtend<{ productId: number }>()
		expectTypeOf<UpdateCartInput>().toExtend<{ shippingAddress?: { postcode?: string } }>()
		expectTypeOf<ListProductInput["orderBy"]>().toEqualTypeOf<ProductOrderBy | undefined>()
	})
})

describe("the error types", () => {
	it("carry the cart procedures' own codes", () => {
		expectTypeOf<"CART_ITEM_EXISTS">().toExtend<CartError["code"]>()
		expectTypeOf<"CART_ITEM_INSUFFICIENT_STOCK">().toExtend<CartError["code"]>()
		// A common code, merged into every procedure's map, which is why a transport failure needs no separate shape.
		expectTypeOf<"INTERNAL_SERVER_ERROR">().toExtend<CartError["code"]>()
	})

	it("do not carry an unrelated procedure's codes", () => {
		expectTypeOf<"CHECKOUT_VALIDATION_FAILED">().not.toExtend<CartError["code"]>()
		expectTypeOf<"CART_ITEM_EXISTS">().not.toExtend<CheckoutError["code"]>()
	})

	it("narrow their payload with the code", () => {
		expectTypeOf<Extract<CheckoutError, { code: "CHECKOUT_VALIDATION_FAILED" }>["data"]>().toEqualTypeOf<{
			fields: Record<string, string>
		}>()
		// A code the store declares without a payload has nothing to read, rather than an `unknown` a call site must guess at.
		expectTypeOf<Extract<CartError, { code: "CART_ITEM_EXISTS" }>["data"]>().toBeNever()
	})

	it("are not the store's own list of problems with the cart", () => {
		// `cart.errors` is what is wrong with the cart as it stands; this is the failure of an action against it. The kit used to
		// export the former as the latter.
		expectTypeOf<Cart["errors"][number]>().not.toExtend<CartError>()
	})
})
