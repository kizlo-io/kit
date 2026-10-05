import type { Checkout } from "../src/types"

// The same augmentation emitted by a consumer's registered WordPress schema contract.
declare module "kizlo" {
	interface WordPressSchemaRegistry {
		"woocommerce.additional-fields.address.read": { "consumer/reference"?: string; "consumer/address-flag"?: boolean }
		"woocommerce.additional-fields.contact.read": { "consumer/contact-flag"?: boolean }
		"woocommerce.additional-fields.order.read": { "consumer/note"?: string }
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
