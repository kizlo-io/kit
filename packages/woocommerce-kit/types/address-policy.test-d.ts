import type { CartAddressSnapshotInput } from "@kizlo/woocommerce-kit"
import type { CartAddressHookOptions } from "@kizlo/woocommerce-kit/react/cart"
import type { CheckoutFieldsApi, CheckoutFieldsOptions, CheckoutFormFieldName } from "@kizlo/woocommerce-kit/react/checkout-fields"
import type { ActiveKizloClient, InferClientData } from "kizlo"
import { expectTypeOf } from "vitest"

type PublicExports =
	| keyof typeof import("@kizlo/woocommerce-kit")
	| keyof typeof import("@kizlo/woocommerce-kit/react")
	| keyof typeof import("@kizlo/woocommerce-kit/react/cart")
	| keyof typeof import("@kizlo/woocommerce-kit/react/checkout")
	| keyof typeof import("@kizlo/woocommerce-kit/react/checkout-fields")
	| keyof typeof import("@kizlo/woocommerce-kit/react/provider")
	| keyof typeof import("@kizlo/woocommerce-kit/react/search")
	| keyof typeof import("@kizlo/woocommerce-kit/react/server")
	| keyof typeof import("@kizlo/woocommerce-kit/react/storefront")

expectTypeOf<Extract<"defaultShouldUpdateAddress" | "isAddressComplete", PublicExports>>().toEqualTypeOf<never>()
expectTypeOf<NonNullable<CheckoutFieldsOptions["validateField"]>>().toEqualTypeOf<
	(name: CheckoutFormFieldName) => boolean | Promise<boolean>
>()
expectTypeOf<CheckoutFieldsApi["handleFieldBlur"]>().toEqualTypeOf<(name: CheckoutFormFieldName) => void>()

type Cart = InferClientData<ActiveKizloClient["woocommerce"]["cart"]["get"]>
expectTypeOf<NonNullable<CartAddressHookOptions["shouldUpdateAddress"]>>().toEqualTypeOf<
	(input: CartAddressSnapshotInput, cart: Cart | null) => boolean
>()
