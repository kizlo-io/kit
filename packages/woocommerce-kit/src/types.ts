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
type ProductProcedures = Procedures["products"]

/** The store's cart, exactly as the client answers it. */
export type Cart = InferClientData<CartProcedures["get"]>

/** One line of the cart. Taken off `Cart` rather than derived again, so the two can never disagree. */
export type CartItem = Cart["items"][number]

/** What `cart.items.add` accepts. */
export type AddCartItemInput = InferClientInput<CartProcedures["items"]["add"]>["body"]

/** What `cart.update` accepts: the customer's addresses. */
export type UpdateCartInput = InferClientInput<CartProcedures["update"]>["body"]

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
