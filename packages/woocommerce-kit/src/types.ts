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
 * `CHECKOUT_VALIDATION_FAILED` carries the offending `fields` on `data`, which is what lets a consumer map a refusal back onto
 * its own form rather than showing one message for every cause.
 */
export type CheckoutError = InferClientError<CheckoutProcedures["get"]> | InferClientError<CheckoutProcedures["confirm"]>

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

/** The application's complete editable snapshot; omitted optional values are authoritative. */
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
export type CheckoutFieldsApi = CheckoutFieldsModel & {
	schema: StandardFieldSchema<CheckoutFieldValues> | null
	isLoading: boolean
	isRepricing: boolean
	error: StorefrontError | CheckoutError | CartError | null
}
