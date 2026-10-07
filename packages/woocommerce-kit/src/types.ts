/**
 * Every type this package exposes about the store, derived from the Kizlo client rather than restated.
 *
 * `ActiveKizloClient` resolves from whatever procedures a project registered, so each of these aliases is whatever *that*
 * project's contract says — custom fields included. Reading the client in one place is the point: a kit that imported its types
 * from `@kizlo/woocommerce` would be describing a client instead of knowing it, and a wrong procedure path or a changed input
 * would compile here and fail in a storefront.
 *
 * `tsconfig.json` includes `types/registry.ts`, so this repository's own type-check resolves these against the real procedure
 * tree. `tsconfig.build.json` does not, so declaration emit leaves them as references for a consumer to resolve.
 *
 * The names are the ones the package has always exported. Only their source moved.
 */

import type { ActiveKizloClient, InferClientData, InferClientError, InferClientInput } from "kizlo"

type Procedures = ActiveKizloClient["woocommerce"]
type CartProcedures = Procedures["cart"]
type CheckoutProcedures = Procedures["checkout"]
type OrderProcedures = Procedures["orders"]
type ProductProcedures = Procedures["products"]
type StorefrontProcedures = Procedures["storefront"]

/** The store's cart, exactly as the client answers it. */
export type Cart = InferClientData<CartProcedures["get"]>

/** The store's shipping address, also the field shape used to compare shipping quotes. */
export type CartShippingAddress = Cart["shippingAddress"]

/** One line of the cart. Taken off `Cart` rather than derived again, so the two can never disagree. */
export type CartItem = Cart["items"][number]

/** What `cart.items.add` accepts. */
export type AddCartItemInput = InferClientInput<CartProcedures["items"]["add"]>["body"]

/** What `cart.update` accepts: the customer's addresses. */
export type UpdateCartInput = InferClientInput<CartProcedures["update"]>["body"]

/** A complete set of pricing fields, with the rest of the procedure's address input available alongside them. */
type AddressSnapshot<T extends { country?: string; state?: string; city?: string; postcode?: string }> = T &
	Required<Pick<T, "country" | "state" | "city" | "postcode">>

/**
 * The current form values for automatic repricing, rather than a patch for one field. Supply every pricing field for each
 * included address, using empty strings for unused fields. A form editing both addresses includes both on every change.
 */
export type CartAddressSnapshotInput = Omit<UpdateCartInput, "shippingAddress" | "billingAddress"> & {
	shippingAddress?: AddressSnapshot<NonNullable<UpdateCartInput["shippingAddress"]>>
	billingAddress?: AddressSnapshot<NonNullable<UpdateCartInput["billingAddress"]>>
}

/**
 * Any way a cart action can fail, as the union of the procedures the cart hooks call.
 *
 * Distinct from the store's `cart.errors`, which is its own list of problems *with* the cart rather than the failure of an
 * action against it. Each member is a `KizloError`, so `code` is a token a call site can branch on and `data` narrows with it.
 * Transport failures arrive here too: the client wraps anything it catches as a common error, and the common map is merged into
 * every procedure's union, so there is no failure outside this type.
 */
export type CartError =
	| InferClientError<CartProcedures["get"]>
	| InferClientError<CartProcedures["update"]>
	| InferClientError<CartProcedures["selectShippingRate"]>
	| InferClientError<CartProcedures["items"]["add"]>
	| InferClientError<CartProcedures["items"]["update"]>
	| InferClientError<CartProcedures["items"]["remove"]>
	| InferClientError<CartProcedures["coupons"]["apply"]>
	| InferClientError<CartProcedures["coupons"]["remove"]>

/** One placed order, as the return route reads it back. */
export type Order = InferClientData<OrderProcedures["get"]>

/** The store's checkout snapshot. */
export type Checkout = InferClientData<CheckoutProcedures["get"]>

/** Everything `checkout.confirm` needs to place the order. */
export type ConfirmCheckoutInput = InferClientInput<CheckoutProcedures["confirm"]>["body"]

/**
 * Any way reading or confirming a checkout can fail.
 *
 * Validation data follows the registered SDK contract. The issues-only SDK exposes messages, source evidence and domain
 * targets; consumers resolve those targets using loaded definitions and their own form handler.
 */
export type CheckoutError = InferClientError<CheckoutProcedures["get"]> | InferClientError<CheckoutProcedures["confirm"]>
export type CheckoutValidationIssue = Extract<CheckoutError, { code: "CHECKOUT_VALIDATION_FAILED" }>["data"]["issues"][number]
export type CheckoutRegisteredFieldReference = CheckoutValidationIssue["registeredFields"][number]
/** SDK evidence plus stable identities assigned to this submission and each individual message. */
export type CheckoutServerIssue = CheckoutValidationIssue & { id: string; submissionId: number; errorCode: CheckoutError["code"] }
export type CheckoutServerFieldError = { name: CheckoutFormFieldName; messages: readonly string[] }

/** A page of products with its paging metadata. */
export type ProductList = InferClientData<ProductProcedures["list"]>

/** One product. Taken off `ProductList` so the collection and its items cannot drift apart. */
export type Product = ProductList["items"][number]

/** The facet counts the collection's sidebar is built from. */
export type ProductFilters = InferClientData<ProductProcedures["filters"]>

/** Every query parameter `products.list` accepts. */
export type ListProductInput = NonNullable<NonNullable<InferClientInput<ProductProcedures["list"]>>["query"]>

/** The columns the store can sort a listing by, so an unsupported one is a compile error rather than an ignored parameter. */
export type ProductOrderBy = NonNullable<ListProductInput["orderBy"]>

/** The store's own settings: its address data, checkout, pricing and catalog configuration, as `storefront.get` answers them. */
export type Storefront = InferClientData<StorefrontProcedures["get"]>

/** Any way reading the store's settings can fail. */
export type StorefrontError = InferClientError<StorefrontProcedures["get"]>

/** Field definitions follow the consumer's registered storefront contract. */
export type StorefrontField = Storefront["address"]["fields"][number]
export type StorefrontFieldRule = StorefrontField["required"]
export type FieldSchema = StorefrontField["schema"]
export type CheckoutFieldLocation = StorefrontField["location"]
export type FieldPresentation = { row?: string; order?: number }
export type ResolvedField = Omit<StorefrontField, "required" | "hidden" | "bindings"> & {
	key: readonly string[]
	required: boolean
	hidden: boolean
	presentation: FieldPresentation
}
export type ResolvedFields = { fields: ResolvedField[]; schema: FieldSchema }
export type FieldResolverOptions<TValues> = {
	fields: readonly StorefrontField[]
	values: TValues
	prefix?: readonly string[]
	presentation?: Readonly<Record<string, FieldPresentation>>
}
export type BillingAddressFieldOptions = FieldResolverOptions<Partial<Cart["billingAddress"]>> & {
	countries: readonly Storefront["address"]["countries"][number][]
}
export type ShippingAddressFieldOptions = FieldResolverOptions<Partial<Cart["shippingAddress"]>> & {
	countries: readonly Storefront["address"]["countries"][number][]
}
export type ContactFieldOptions = FieldResolverOptions<{
	billingAddress?: Partial<Pick<Checkout["billingAddress"], "email">>
	additionalFields?: Checkout["additionalFields"]
}>
export type OrderFieldOptions = FieldResolverOptions<Pick<Partial<Checkout>, "additionalFields">>

/** Implements Standard Schema v1 without depending on a form library. */
export type StandardFieldSchema<T> = {
	readonly "~standard": {
		readonly version: 1
		readonly vendor: string
		readonly types?: { input: T; output: T }
		readonly validate: (value: unknown) => { value: T } | { issues: { message: string; path?: readonly (string | number)[] }[] }
	}
}

/** Raw SDK-shaped field values, also used by the independent core resolvers. */
export type CheckoutFieldValues = Partial<ConfirmCheckoutInput>
export type CheckoutFieldGroup = "billing" | "shipping" | "contact" | "order"
export type CheckoutFieldDiagnostic = {
	fieldId: string
	group: CheckoutFieldGroup
	path: readonly string[]
	reason: "unavailable-data" | "invalid-schema" | "unsupported-widget" | "invalid-binding" | "binding-collision"
	message: string
}
export type CheckoutFieldsModel = {
	fields: Record<CheckoutFieldGroup, ResolvedField[]>
	defaultValues: CheckoutFieldValues | null
	unsupported: CheckoutFieldDiagnostic[]
}
/** Opaque additional-field IDs are encoded independently of structural form paths. */
type FormEscape = { "%": "%25"; "/": "%2F"; ".": "%2E"; "[": "%5B"; "]": "%5D"; "'": "%27"; '"': "%22" }
type FormId<T extends string, Encoded extends string = ""> = string extends T
	? string
	: T extends `${infer Head}${infer Tail}`
		? FormId<Tail, `${Encoded}${Head extends keyof FormEscape ? FormEscape[Head] : Head}`>
		: Encoded
export type CheckoutFormId<T extends string> = FormId<T>
type FormAdditionalFields<T> = T extends object ? { [K in keyof T as K extends string ? CheckoutFormId<K> : K]: T[K] } : T
type FormRepresentation<T> = {
	[K in keyof T]: K extends "additionalFields"
		? FormAdditionalFields<T[K]>
		: K extends "billingAddress" | "shippingAddress"
			? FormRepresentation<T[K]>
			: T[K]
}
/** The form library's encoded representation; form-only controls never reach SDK output. */
export type CheckoutFormValues = FormRepresentation<CheckoutFieldValues> & { useShippingAsBilling?: boolean }
type ScalarName<T> = { [K in keyof T & string]: NonNullable<T[K]> extends string | boolean | number ? K : never }[keyof T & string]
type AddressFormNames<T> =
	| ScalarName<T>
	| (T extends { additionalFields?: infer F } ? `additionalFields.${keyof NonNullable<F> & string}` : never)
export type CheckoutFormFieldName =
	| ScalarName<CheckoutFormValues>
	| `billingAddress.${AddressFormNames<NonNullable<CheckoutFormValues["billingAddress"]>>}`
	| `shippingAddress.${AddressFormNames<NonNullable<CheckoutFormValues["shippingAddress"]>>}`
	| `additionalFields.${keyof NonNullable<CheckoutFormValues["additionalFields"]> & string}`
type ScalarValue<T> = T extends object ? { [K in keyof T]: ScalarValue<T[K]> }[keyof T] : Extract<T, string | boolean | number>
export type CheckoutFieldValue = ScalarValue<
	Pick<
		CheckoutFormValues,
		"billingAddress" | "shippingAddress" | "additionalFields" | "paymentMethod" | "customerNote" | "createAccount" | "useShippingAsBilling"
	>
>
export type CheckoutFieldUpdate = {
	name: CheckoutFormFieldName
	value: CheckoutFieldValue | undefined
	options: { runListeners: boolean; meta: "preserve" | "update"; validate: boolean }
}
export type CheckoutServerErrorCallbacks = {
	/** Patch only the form's Kit-managed server channel, preserving client validation and interaction metadata. */
	setErrors: (errors: readonly CheckoutServerFieldError[]) => void
	clearErrors: (names: readonly CheckoutFormFieldName[]) => void
}
export type CheckoutFieldsOptions = {
	getValues?: () => CheckoutFormValues | undefined
	setValues?: (updates: readonly CheckoutFieldUpdate[]) => void
} & (CheckoutServerErrorCallbacks | { setErrors?: undefined; clearErrors?: undefined })
export type CheckoutFieldBinding = {
	value: CheckoutFieldValue | undefined
	onValueChange: (value: CheckoutFieldValue | undefined) => void
	onBlur?: () => void
	invalid?: boolean
}
export type CheckoutControlProps = {
	id: string
	name: CheckoutFormFieldName
	required: boolean
	autoComplete?: string
	placeholder?: string
	"aria-invalid": boolean
	"aria-describedby"?: string
	onBlur?: () => void
	disabled?: boolean
	readOnly?: boolean
	min?: string | number
	max?: string | number
	step?: string | number
	minLength?: number
	maxLength?: number
	pattern?: string
	title?: string
}
export type CheckoutNativeControl =
	| {
			kind: "input"
			errorId: string
			props: CheckoutControlProps & {
				type: string
				value?: string | number
				checked?: boolean
				onChange: (event: { currentTarget: { value: string; checked: boolean; valueAsNumber: number } }) => void
			}
	  }
	| {
			kind: "select"
			errorId: string
			props: CheckoutControlProps & { value: string; onChange: (event: { currentTarget: { value: string } }) => void }
	  }
	| {
			kind: "textarea"
			errorId: string
			props: CheckoutControlProps & { value: string; onChange: (event: { currentTarget: { value: string } }) => void }
	  }
export type CheckoutFormField = ResolvedField & {
	name: CheckoutFormFieldName
	getProps: (binding: CheckoutFieldBinding) => CheckoutNativeControl
}
export type CheckoutFieldsSection = { fields: CheckoutFormField[]; errors: readonly CheckoutServerIssue[] }
export type CheckoutFieldsApi = Omit<CheckoutFieldsModel, "fields" | "defaultValues"> & {
	billing: CheckoutFieldsSection
	shipping: CheckoutFieldsSection
	contact: CheckoutFieldsSection
	order: CheckoutFieldsSection
	/** General, unresolved or otherwise unplaceable submission failures. */
	errors: readonly CheckoutServerIssue[]
	defaultValues: CheckoutFormValues | null
	schema: StandardFieldSchema<CheckoutFormValues> | null
	canUseShippingAsBilling: boolean
	handleFieldChange: (name: CheckoutFormFieldName, value: CheckoutFieldValue | undefined) => void
	reevaluate: () => void
	getInput: (values: CheckoutFieldValues) => CheckoutFormValues
	getOutput: (values: CheckoutFormValues) => CheckoutFieldValues
	isLoading: boolean
	isRepricing: boolean
	error: StorefrontError | CheckoutError | CartError | null
}
