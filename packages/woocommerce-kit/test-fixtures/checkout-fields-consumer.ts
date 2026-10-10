import type { woocommerce } from "@kizlo/woocommerce"
import type { CheckoutFieldsApi, CheckoutFieldValues, CheckoutFormValues, ConfirmCheckoutInput } from "@kizlo/woocommerce-kit"
import type { Procedure, RootProcedures } from "kizlo"

type Base = RootProcedures<[ReturnType<typeof woocommerce>]>
type BodyWithBilling<T> = T extends { body: infer B extends { billingAddress: object } }
	? Omit<T, "body"> & {
			body: Omit<B, "billingAddress"> & {
				billingAddress: Omit<B["billingAddress"], "additionalFields"> & {
					additionalFields: { "required/address": "home" | "office"; "optional/address"?: boolean } & Record<
						string,
						string | boolean | undefined
					>
				}
			}
		}
	: never
type Confirm =
	Base["woocommerce"]["checkout"]["confirm"] extends Procedure<"api", infer Input, infer Data, infer Errors>
		? Procedure<"api", BodyWithBilling<Input>, Data, Errors>
		: never
type Consumer = Omit<Base, "woocommerce"> & {
	woocommerce: Omit<Base["woocommerce"], "checkout"> & {
		checkout: Omit<Base["woocommerce"]["checkout"], "confirm"> & { confirm: Confirm }
	}
}

declare module "kizlo" {
	interface KizloProcedureRegistry {
		procedures: Consumer
	}
	interface WordPressSchemaRegistry {
		"woocommerce.additional-fields.address.write": { "required/address": "home" | "office"; "optional/address"?: boolean } & Record<
			string,
			string | boolean | undefined
		>
		"woocommerce.additional-fields.checkout.write": { "required/choice": "red" | "blue"; "optional/quantity"?: number } & Record<
			string,
			string | boolean | number | undefined
		>
	}
}

declare const fields: CheckoutFieldsApi
const draft: CheckoutFormValues = {
	billingAddress: { country: "", additionalFields: { "required%2Faddress": "" } },
	shippingAddress: { additionalFields: { "required%2Faddress": "home" } },
	additionalFields: { "required%2Fchoice": "", "optional%2Fquantity": 2 },
	paymentMethod: "",
	useShippingAsBilling: true,
}
const rawDraft: CheckoutFieldValues = {
	billingAddress: { additionalFields: { "required/address": "" } },
	useShippingAsBilling: true,
}
const encoded: CheckoutFormValues = fields.encode(rawDraft)
const output: CheckoutFieldValues = fields.decode(draft)
const billingChoice: "home" | "office" | "" | undefined = output.billingAddress?.additionalFields?.["required/address"]
const shippingChoice: "home" | "office" | "" | undefined = output.shippingAddress?.additionalFields?.["required/address"]
const orderChoice: "red" | "blue" | "" | undefined = output.additionalFields?.["required/choice"]
const encodedChoice: "home" | "office" | "" | undefined = encoded.billingAddress?.additionalFields?.["required%2Faddress"]
const sharing: boolean | undefined = output.useShippingAsBilling
// @ts-expect-error Decoded drafts do not claim to be complete confirmation requests.
const confirmation: ConfirmCheckoutInput = output
if (output.additionalFields) {
	// @ts-expect-error Decoding preserves active-client enums, including the editable placeholder.
	output.additionalFields["required/choice"] = "green"
}
// @ts-expect-error Draft placeholders do not erase registered scalar types.
const wrongDraft: CheckoutFormValues = { additionalFields: { "optional%2Fquantity": "2" } }
// @ts-expect-error Encoding also preserves the registered scalar type.
fields.encode({ additionalFields: { "optional/quantity": "2" } })
// @ts-expect-error Generated address enums remain typed in their encoded location.
fields.encode({ shippingAddress: { additionalFields: { "required/address": "green" } } })
void [billingChoice, shippingChoice, orderChoice, encodedChoice, sharing, wrongDraft, confirmation]

const prepared: ConfirmCheckoutInput = fields.toCheckout({ values: draft, input: { expectedTotal: "12345" } })
const requiredAddress: "home" | "office" = prepared.billingAddress.additionalFields["required/address"]
const requiredOrder: "red" | "blue" | undefined = prepared.additionalFields?.["required/choice"]
// @ts-expect-error Top-level raw replacements retain the registered required address answer.
fields.toCheckout({ input: { billingAddress: { ...prepared.billingAddress, additionalFields: {} } } })
// @ts-expect-error Raw input overrides retain registered enums.
fields.toCheckout({ input: { additionalFields: { "required/choice": "green" } } })
// @ts-expect-error Provider token values cannot become numbers.
fields.toCheckout({ input: { paymentData: [{ key: "token", value: 3 }] } })
if (fields.isReady) {
	const child: import("../src/types").ReadyCheckoutFieldsApi = fields
	const defaults: CheckoutFormValues = fields.defaultValues
	const schema: NonNullable<CheckoutFieldsApi["schema"]> = fields.schema
	const callback = () => {
		const readySchema: NonNullable<CheckoutFieldsApi["schema"]> = fields.schema
		return readySchema
	}
	void [child, defaults, schema, callback]
}
void [prepared, requiredAddress, requiredOrder]
