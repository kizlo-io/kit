import type { StandardSchemaV1 } from "@standard-schema/spec"
import { expectTypeOf } from "vitest"
import type { useCheckoutFields } from "./react/checkout-fields"
import type { CheckoutFieldsApi, CheckoutFieldValues, ConfirmCheckoutInput } from "./types"

expectTypeOf<CheckoutFieldValues>().toEqualTypeOf<Partial<ConfirmCheckoutInput>>()
expectTypeOf<NonNullable<CheckoutFieldsApi["schema"]>>().toExtend<StandardSchemaV1<CheckoutFieldValues>>()
expectTypeOf<CheckoutFieldsApi["defaultValues"]>().toEqualTypeOf<CheckoutFieldValues | null>()
expectTypeOf<ReturnType<typeof useCheckoutFields>>().toEqualTypeOf<CheckoutFieldsApi>()
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("billing")
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("shipping")
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("contact")
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("order")
