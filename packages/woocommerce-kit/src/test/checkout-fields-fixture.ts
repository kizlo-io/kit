import type { CheckoutFieldSources } from "../checkout-field-document"
import type { Cart, Checkout, CheckoutFieldValues, Storefront, StorefrontField } from "../types"
import evidence from "./fixtures/checkout-conditions.json"

export function field(id: string, overrides: Partial<StorefrontField> = {}): StorefrontField {
	return {
		id,
		location: "order",
		label: id,
		optionalLabel: id,
		required: false,
		hidden: false,
		type: "text",
		autocomplete: null,
		index: null,
		placeholder: null,
		options: [],
		attributes: {},
		schema: { type: "string" },
		bindings: { other: ["additionalFields", id] },
		...overrides,
	}
}
export function fixtures(
	fields: StorefrontField[] = [field(evidence.fieldId, { required: evidence.requiredRule })],
): CheckoutFieldSources & {
	storefront: Storefront
	cart: Cart
	checkout: Checkout
	values: CheckoutFieldValues
} {
	const billingAddress = {
		firstName: "Ada",
		lastName: "Lovelace",
		company: "",
		address1: "Road",
		address2: "",
		city: "Bengaluru",
		state: "KA",
		postcode: "560001",
		country: "IN",
		phone: "",
		email: "ada@example.com",
		taxId: "TAX",
		additionalFields: {},
	}
	const shippingAddress = { ...billingAddress, country: "GB", state: "", additionalFields: {} }
	const values = {
		billingAddress,
		shippingAddress,
		paymentMethod: "bacs",
		customerNote: "saved",
		createAccount: false,
		additionalFields: { [evidence.fieldId]: evidence.submittedValue },
	}
	const cart = {
		billingAddress,
		shippingAddress,
		coupons: [{ code: "SAVE" }],
		itemCount: 2.25,
		itemsWeight: 1.7,
		needsShipping: true,
		needsPayment: true,
		paymentMethods: [{ id: "bacs", title: "Bank transfer", description: "", order: 0, enabled: true }],
		currencyFormat: {
			currencyCode: "INR",
			currencySymbol: "₹",
			currencyPrefix: "₹",
			currencySuffix: "",
			currencyMinorUnit: 2,
			currencyDecimalSeparator: ".",
			currencyThousandSeparator: ",",
		},
		items: [
			{ productId: 42, variationId: null, quantity: 1.25, type: "simple" },
			{ productId: 88, variationId: 91, quantity: 0.5, type: "variation" },
			{ productId: 43, variationId: null, quantity: 0.5, type: "simple" },
		],
		shippingPackages: [
			{ id: 0, rates: [{ id: evidence.rateId, methodId: evidence.methodId, selected: true }] },
			{ id: 1, rates: [{ id: evidence.rateId, methodId: "flat_rate", selected: true }] },
		],
		totals: { total: 12345, taxTotal: 321 },
		extensions: evidence.cartExtensions,
	} as unknown as Cart
	const checkout = {
		...values,
		cart,
		customerId: null,
		orderId: 12,
		orderKey: "key",
		isPaid: false,
		paymentResult: null,
	} as unknown as Checkout
	const storefront = {
		address: {
			fields,
			countries: [
				{
					code: "IN",
					name: "India",
					allowBilling: true,
					allowShipping: true,
					states: [{ code: "KA", name: "Karnataka" }],
					locale: {},
					format: "",
				},
				{
					code: "GB",
					name: "United Kingdom",
					allowBilling: true,
					allowShipping: false,
					states: [],
					locale: { state: { required: false, label: "County" } },
					format: "",
				},
				{ code: "AE", name: "UAE", allowBilling: true, allowShipping: true, states: [], locale: { state: { hidden: true } }, format: "" },
			],
		},
		checkout: { localPickup: { methodIds: [evidence.methodId, "local_pickup"] } },
	} as unknown as Storefront
	return { storefront, cart, checkout, values }
}
