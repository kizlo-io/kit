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

expectTypeOf<ConfirmCheckoutInput>().toExtend<CheckoutFieldValues>()
expectTypeOf<NonNullable<CheckoutFieldsApi["schema"]>>().toExtend<StandardSchemaV1<CheckoutFormValues>>()
expectTypeOf<CheckoutFieldsApi["defaultValues"]>().toEqualTypeOf<CheckoutFormValues | null>()
expectTypeOf<ReturnType<typeof useCheckoutFields>>().toEqualTypeOf<CheckoutFieldsApi>()
expectTypeOf<CheckoutFieldsApi["billing"]>().toHaveProperty("fields")
expectTypeOf<CheckoutFieldsApi["shipping"]>().toHaveProperty("fields")
expectTypeOf<CheckoutFieldsApi["contact"]>().toHaveProperty("fields")
expectTypeOf<CheckoutFieldsApi["order"]>().toHaveProperty("fields")

expectTypeOf<CheckoutFormId<"plugin/a.b[0]'%">>().toEqualTypeOf<"plugin%2Fa%2Eb%5B0%5D%27%25">()
type FormSchema = NonNullable<CheckoutFieldsApi["schema"]>
expectTypeOf<StandardSchemaV1.InferInput<FormSchema>>().toEqualTypeOf<CheckoutFormValues>()
expectTypeOf<StandardSchemaV1.InferOutput<FormSchema>>().toEqualTypeOf<CheckoutFormValues>()
expectTypeOf<Parameters<CheckoutFieldsApi["encode"]>[0]>().toEqualTypeOf<CheckoutFieldValues>()
expectTypeOf<ReturnType<CheckoutFieldsApi["encode"]>>().toEqualTypeOf<CheckoutFormValues>()
expectTypeOf<Parameters<CheckoutFieldsApi["decode"]>[0]>().toEqualTypeOf<CheckoutFormValues>()
expectTypeOf<ReturnType<CheckoutFieldsApi["decode"]>>().toEqualTypeOf<CheckoutFieldValues>()
declare const fields: CheckoutFieldsApi
declare const formValues: CheckoutFormValues
expectTypeOf(fields.decode(formValues).useShippingAsBilling).toEqualTypeOf<boolean | undefined>()
// @ts-expect-error Decoding keys does not establish a complete confirmation request.
const confirmation: ConfirmCheckoutInput = fields.decode(formValues)
// @ts-expect-error The key converters replace the ambiguous getter names.
void fields.getInput
// @ts-expect-error The key converters replace the ambiguous getter names.
void fields.getOutput
void confirmation
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

expectTypeOf<ReturnType<CheckoutFieldsApi["toCheckout"]>>().toEqualTypeOf<ConfirmCheckoutInput>()
const prepared: ConfirmCheckoutInput = fields.toCheckout({
	values: formValues,
	input: { paymentData: [{ key: "token", value: false }], expectedTotal: undefined },
})
// @ts-expect-error Provider payload values follow the registered SDK contract.
fields.toCheckout({ input: { paymentData: [{ key: "token", value: 1 }] } })
// @ts-expect-error An availability guard is required for native validators.
const unguardedSchema: FormSchema = fields.schema
// @ts-expect-error An availability guard is required for child defaults.
const unguardedDefaults: CheckoutFormValues = fields.defaultValues
if (fields.isReady) {
	const ready: import("./types").ReadyCheckoutFieldsApi = fields
	const validator: FormSchema = fields.schema
	const defaults: CheckoutFormValues = fields.defaultValues
	const session: string = fields.session
	const callback = () => {
		const schema: FormSchema = fields.schema
		return schema
	}
	void [ready, validator, defaults, session, callback]
} else {
	expectTypeOf(fields.schema).toEqualTypeOf<null>()
	expectTypeOf(fields.reason).toEqualTypeOf<import("./types").CheckoutFieldsUnavailableReason>()
}
void [prepared, unguardedSchema, unguardedDefaults]
