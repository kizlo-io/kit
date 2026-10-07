import type { StandardSchemaV1 } from "@standard-schema/spec"
import { expectTypeOf } from "vitest"
import type { useCheckoutFields } from "./react/checkout-fields"
import type {
	CheckoutFieldsApi,
	CheckoutFieldsOptions,
	CheckoutFieldValues,
	CheckoutFormFieldName,
	CheckoutFormId,
	CheckoutFormValues,
	CheckoutRegisteredFieldReference,
	CheckoutServerErrorCallbacks,
	CheckoutServerFieldError,
	CheckoutServerIssue,
	CheckoutValidationIssue,
	ConfirmCheckoutInput,
} from "./types"

expectTypeOf<CheckoutFieldValues>().toEqualTypeOf<Partial<ConfirmCheckoutInput>>()
expectTypeOf<NonNullable<CheckoutFieldsApi["schema"]>>().toExtend<StandardSchemaV1<CheckoutFormValues>>()
expectTypeOf<CheckoutFieldsApi["defaultValues"]>().toEqualTypeOf<CheckoutFormValues | null>()
expectTypeOf<ReturnType<typeof useCheckoutFields>>().toEqualTypeOf<CheckoutFieldsApi>()
expectTypeOf<CheckoutFieldsApi["billing"]>().toHaveProperty("fields")
expectTypeOf<CheckoutFieldsApi["shipping"]>().toHaveProperty("fields")
expectTypeOf<CheckoutFieldsApi["contact"]>().toHaveProperty("fields")
expectTypeOf<CheckoutFieldsApi["order"]>().toHaveProperty("fields")

expectTypeOf<CheckoutFormId<"plugin/a.b[0]'%">>().toEqualTypeOf<"plugin%2Fa%2Eb%5B0%5D%27%25">()
expectTypeOf<ReturnType<CheckoutFieldsApi["getOutput"]>>().toExtend<Partial<ConfirmCheckoutInput>>()
declare const oldValues: CheckoutFieldValues
// @ts-expect-error The form accessors replace the render-driven values argument.
const oldOptions: CheckoutFieldsOptions = { values: oldValues }
void oldOptions

expectTypeOf<CheckoutRegisteredFieldReference>().toEqualTypeOf<{
	id: string
	bucket: "billingAddress" | "shippingAddress" | "additionalFields" | null
}>()
expectTypeOf<CheckoutServerIssue>().toExtend<CheckoutValidationIssue>()
expectTypeOf<CheckoutFieldsApi["errors"]>().toEqualTypeOf<readonly CheckoutServerIssue[]>()
expectTypeOf<CheckoutFieldsApi["shipping"]["errors"]>().toEqualTypeOf<readonly CheckoutServerIssue[]>()
expectTypeOf<Parameters<CheckoutServerErrorCallbacks["setErrors"]>[0]>().toEqualTypeOf<readonly CheckoutServerFieldError[]>()
expectTypeOf<Parameters<CheckoutServerErrorCallbacks["clearErrors"]>[0]>().toEqualTypeOf<readonly CheckoutFormFieldName[]>()
// @ts-expect-error Configure both server-only callbacks together.
const missingClear: CheckoutFieldsOptions = { setErrors: () => {} }
// @ts-expect-error The return shape is section.fields, replacing the old fields.section shape.
declare const legacyFields: CheckoutFieldsApi["fields"]
void [missingClear, legacyFields]
