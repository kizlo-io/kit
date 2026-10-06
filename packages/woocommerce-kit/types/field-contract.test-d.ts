import type { Checkout } from "../src/types"

// The same augmentation emitted by a consumer's registered WordPress schema contract.
declare module "kizlo" {
	interface WordPressSchemaRegistry {
		"woocommerce.additional-fields.address.read": { "consumer/reference"?: string; "consumer/address-flag"?: boolean }
		"woocommerce.additional-fields.contact.read": { "consumer/contact-flag"?: boolean }
		"woocommerce.additional-fields.order.read": { "consumer/note"?: string }
		"woocommerce.additional-fields.checkout.write": {
			"consumer/contact-flag"?: boolean
			"consumer/note"?: string
			"consumer/quantity.a[0]'%%"?: number
		} & Record<string, string | boolean | number | undefined>
		"woocommerce.additional-fields.address.write": {
			"consumer/reference"?: string
			"consumer/address-flag"?: boolean
		} & Record<string, string | boolean | undefined>
		"woocommerce.additional-fields.checkout.read": { "consumer/contact-flag"?: boolean; "consumer/note"?: string }
	}
}

const contact: Checkout["additionalFields"]["consumer/contact-flag"] = false
const reference: Checkout["shippingAddress"]["additionalFields"]["consumer/reference"] = "Buyer"
// @ts-expect-error Registered checkbox values stay boolean through ActiveKizloClient.
const wrongCheckbox: Checkout["additionalFields"]["consumer/contact-flag"] = "false"
// @ts-expect-error Registered address text fields stay strings.
const wrongReference: Checkout["billingAddress"]["additionalFields"]["consumer/reference"] = true
const inferredContact: Checkout["additionalFields"]["consumer/contact-flag"] = contact
void [reference, wrongCheckbox, wrongReference, inferredContact]

import type { CheckoutFieldValues } from "../src/react/checkout-fields"

const checkoutFlag: NonNullable<CheckoutFieldValues["additionalFields"]>["consumer/contact-flag"] = false
const checkoutReference: NonNullable<NonNullable<CheckoutFieldValues["billingAddress"]>["additionalFields"]>["consumer/reference"] = "Buyer"
// @ts-expect-error Registered checkbox input remains boolean in the full controlled form.
const wrongCheckoutFlag: NonNullable<CheckoutFieldValues["additionalFields"]>["consumer/contact-flag"] = "false"
void [checkoutFlag, checkoutReference, wrongCheckoutFlag]

import type { CheckoutFieldValue, CheckoutFormFieldName, CheckoutFormValues } from "../src/types"

const numberValue: CheckoutFieldValue = 12
const numberInput: NonNullable<CheckoutFormValues["additionalFields"]>["consumer%2Fquantity%2Ea%5B0%5D%27%25%25"] = 12
const numberName: CheckoutFormFieldName = "additionalFields.consumer%2Fquantity%2Ea%5B0%5D%27%25%25"
// @ts-expect-error A registered number field cannot be edited as a string.
const wrongNumberInput: NonNullable<CheckoutFormValues["additionalFields"]>["consumer%2Fquantity%2Ea%5B0%5D%27%25%25"] = "12"
void [numberValue, numberInput, numberName, wrongNumberInput]
