import type { ActiveKizloClient, InferClientData, InferClientInput } from "kizlo"
import { expectTypeOf } from "vitest"
import type { CartAddressApi, CartCouponApi, CartItemApi, CartItemQuantity, CartShippingRatesApi } from "../src/react/cart"
import type { CheckoutApi } from "../src/react/checkout"
import type { Cart, CartAddressSnapshotInput, Checkout } from "../src/types"

type Procedures = ActiveKizloClient["woocommerce"]
expectTypeOf<ReturnType<CheckoutApi["confirmAsync"]>>().toEqualTypeOf<Promise<InferClientData<Procedures["checkout"]["confirm"]>>>()
expectTypeOf<Parameters<CheckoutApi["confirmAsync"]>[0]>().toEqualTypeOf<InferClientInput<Procedures["checkout"]["confirm"]>["body"]>()
expectTypeOf<Parameters<CartItemApi["addItemAsync"]>>().toEqualTypeOf<Parameters<CartItemApi["addItem"]>>()
expectTypeOf<Parameters<CartAddressApi["updateAsync"]>>().toEqualTypeOf<Parameters<CartAddressApi["update"]>>()
expectTypeOf<Parameters<CartShippingRatesApi["selectShippingRateAsync"]>>().toEqualTypeOf<
	Parameters<CartShippingRatesApi["selectShippingRate"]>
>()
expectTypeOf<Parameters<CartCouponApi["applyAsync"]>>().toEqualTypeOf<Parameters<CartCouponApi["apply"]>>()
expectTypeOf<Parameters<CartAddressApi["onAddressChangeAsync"]>[0]>().toEqualTypeOf<CartAddressSnapshotInput>()
expectTypeOf<ReturnType<CartItemApi["addItemAsync"]>>().toEqualTypeOf<Promise<Cart>>()
expectTypeOf<ReturnType<CartAddressApi["updateAsync"]>>().toEqualTypeOf<Promise<Cart>>()
expectTypeOf<ReturnType<CartShippingRatesApi["selectShippingRateAsync"]>>().toEqualTypeOf<Promise<Cart>>()
expectTypeOf<ReturnType<CartCouponApi["applyAsync"]>>().toEqualTypeOf<Promise<Cart>>()
expectTypeOf<ReturnType<CartItemApi["removeAsync"]>>().toEqualTypeOf<Promise<Cart | undefined>>()
expectTypeOf<ReturnType<CartCouponApi["removeAsync"]>>().toEqualTypeOf<Promise<Cart | undefined>>()
expectTypeOf<ReturnType<CartAddressApi["onAddressChangeAsync"]>>().toEqualTypeOf<Promise<Cart | undefined>>()
expectTypeOf<ReturnType<CartItemQuantity["commitAsync"]>>().toEqualTypeOf<Promise<Cart | undefined>>()
expectTypeOf<ReturnType<CartItemQuantity["commit"]>>().toEqualTypeOf<Promise<void>>()
expectTypeOf<ReturnType<CheckoutApi["confirm"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartItemApi["addItem"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartItemApi["remove"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartAddressApi["update"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartAddressApi["onAddressChange"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartShippingRatesApi["selectShippingRate"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartCouponApi["apply"]>>().toEqualTypeOf<void>()
expectTypeOf<ReturnType<CartCouponApi["remove"]>>().toEqualTypeOf<void>()

// The field-contract suite augments the active consumer contract with these typed custom fields.
declare const api: CheckoutApi
declare const address: CartAddressApi
declare const input: Parameters<CheckoutApi["confirmAsync"]>[0]
api.confirmAsync({ ...input, additionalFields: { "consumer/contact-flag": false } })
// @ts-expect-error A consumer's registered checkbox remains boolean in the async input.
api.confirmAsync({ ...input, additionalFields: { "consumer/contact-flag": "false" } })
address.updateAsync({ billingAddress: { additionalFields: { "consumer/reference": "Buyer" } } })
expectTypeOf<Awaited<ReturnType<CheckoutApi["confirmAsync"]>>>().toEqualTypeOf<Checkout>()
expectTypeOf<Awaited<ReturnType<CheckoutApi["confirmAsync"]>>["additionalFields"]["consumer/contact-flag"]>().toEqualTypeOf<
	boolean | undefined
>()
