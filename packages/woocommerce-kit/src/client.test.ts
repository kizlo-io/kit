/**
 * The kit's calls, checked against the WooCommerce contract rather than against a description of it.
 *
 * Type-level only — every assertion takes its subject as a type argument, so nothing is dereferenced at runtime and `pnpm test`
 * has nothing to execute. `pnpm typecheck` is what enforces this file, because `tsconfig.json` includes both `src/**` and the
 * registry fill in `types/`. It is the regression for the four hand-written client mirrors this package used to ship: if a
 * procedure the kit calls is renamed or retyped upstream, these assertions stop compiling instead of the drift surfacing in a
 * storefront.
 */

import type { Cart, ProductList } from "@kizlo/woocommerce"
import type { ActiveKizloClient } from "kizlo"
import { describe, expectTypeOf, it } from "vitest"

type CartProcedures = ActiveKizloClient["woocommerce"]["cart"]
type ProductProcedures = ActiveKizloClient["woocommerce"]["products"]

describe("the registered Kizlo client", () => {
	it("answers the cart procedures the cart hooks call", () => {
		expectTypeOf<Awaited<ReturnType<CartProcedures["get"]["call"]>>>().toExtend<Cart>()
		expectTypeOf<CartProcedures["items"]["add"]["call"]>().toBeFunction()
		expectTypeOf<CartProcedures["items"]["remove"]["call"]>().toBeFunction()
		expectTypeOf<CartProcedures["coupons"]["apply"]["call"]>().toBeFunction()
		expectTypeOf<CartProcedures["selectShippingRate"]["call"]>().toBeFunction()
	})

	it("answers the product procedures the collection and the typeahead call", () => {
		expectTypeOf<Awaited<ReturnType<ProductProcedures["list"]["call"]>>>().toExtend<ProductList>()
		expectTypeOf<ProductProcedures["filters"]["call"]>().toBeFunction()
	})

	it("carries only the integrations this repo registers", () => {
		expectTypeOf<"shopify">().not.toExtend<keyof ActiveKizloClient>()
	})
})
