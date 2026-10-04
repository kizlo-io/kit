import type { Checkout, CheckoutFieldValue, CheckoutFieldValuePath } from "./types"

const firstName: CheckoutFieldValue<readonly ["billingAddress", "firstName"]> = "Ada"
const taxId: CheckoutFieldValue<readonly ["billingAddress", "taxId"]> = "GB"
const literal: CheckoutFieldValuePath = ["shippingAddress", "additionalFields", "plug/a.b[0]"]
// @ts-expect-error Wrong value type for a core target.
const wrongValue: CheckoutFieldValue<readonly ["billingAddress", "firstName"]> = false
// @ts-expect-error Raw Woo IDs are not core SDK target properties.
const wrongPath: CheckoutFieldValuePath = ["billingAddress", "first_name"]
// @ts-expect-error Billing native projections do not create shipping properties.
const wrongGroup: CheckoutFieldValuePath = ["shippingAddress", "taxId"]
const activeValue: Checkout["billingAddress"]["taxId"] = taxId
void [firstName, literal, wrongValue, wrongPath, wrongGroup, activeValue]
