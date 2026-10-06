import type { StandardSchemaV1 } from "@standard-schema/spec"
import { expectTypeOf } from "vitest"
import type { useCheckoutFields } from "./react/checkout-fields"
import type {
	CheckoutFieldsApi,
	CheckoutFieldsOptions,
	CheckoutFieldValues,
	CheckoutFormId,
	CheckoutFormValues,
	ConfirmCheckoutInput,
} from "./types"

expectTypeOf<CheckoutFieldValues>().toEqualTypeOf<Partial<ConfirmCheckoutInput>>()
expectTypeOf<NonNullable<CheckoutFieldsApi["schema"]>>().toExtend<StandardSchemaV1<CheckoutFormValues>>()
expectTypeOf<CheckoutFieldsApi["defaultValues"]>().toEqualTypeOf<CheckoutFormValues | null>()
expectTypeOf<ReturnType<typeof useCheckoutFields>>().toEqualTypeOf<CheckoutFieldsApi>()
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("billing")
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("shipping")
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("contact")
expectTypeOf<CheckoutFieldsApi["fields"]>().toHaveProperty("order")

expectTypeOf<CheckoutFormId<"plugin/a.b[0]'%">>().toEqualTypeOf<"plugin%2Fa%2Eb%5B0%5D%27%25">()
expectTypeOf<ReturnType<CheckoutFieldsApi["getOutput"]>>().toExtend<Partial<ConfirmCheckoutInput>>()
declare const oldValues: CheckoutFieldValues
// @ts-expect-error The form accessors replace the render-driven values argument.
const oldOptions: CheckoutFieldsOptions = { values: oldValues }
void oldOptions
