import type { StandardSchemaV1 } from "@standard-schema/spec"
import { toStandardSchema } from "./field-schema"
import { resolveBillingAddressFields, resolveContactFields, resolveOrderFields, resolveShippingAddressFields } from "./fields"
import type { Cart, Checkout, Storefront } from "./types"

declare const store: Storefront
declare const billing: Cart["billingAddress"]
declare const shipping: Cart["shippingAddress"]
declare const checkout: Checkout
const result = resolveBillingAddressFields({ fields: store.address.fields, countries: store.address.countries, values: billing })
resolveShippingAddressFields({ fields: store.address.fields, countries: store.address.countries, values: shipping })
resolveContactFields({
	fields: store.address.fields,
	values: { billingAddress: { email: checkout.billingAddress.email }, additionalFields: checkout.additionalFields },
})
resolveOrderFields({ fields: store.address.fields, values: { additionalFields: checkout.additionalFields } })
const standard = toStandardSchema<typeof billing>(
	(values) => resolveBillingAddressFields({ fields: store.address.fields, countries: store.address.countries, values }).schema,
)
const version: 1 = standard["~standard"].version
// @ts-expect-error Values use the SDK's camel case address keys.
resolveBillingAddressFields({ fields: store.address.fields, countries: store.address.countries, values: { first_name: "Ada" } })
// @ts-expect-error Every call supplies the current values.
resolveBillingAddressFields({ fields: store.address.fields, countries: store.address.countries })
void [result, version]

const specCompatible: StandardSchemaV1<typeof billing> = standard
void specCompatible
