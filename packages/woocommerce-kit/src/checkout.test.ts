import { describe, expect, it } from "vitest"
import { orderOutcome, parseCheckoutReturn, resolveCheckoutRedirect } from "./checkout"
import type { Checkout, Order } from "./types"

/** Only the fields `resolveCheckoutRedirect` reads. The rest of a checkout says nothing about where the browser goes next. */
function confirmed(checkout: { orderId: Checkout["orderId"]; orderKey: Checkout["orderKey"]; paymentResult: Checkout["paymentResult"] }) {
	return checkout as Checkout
}

function paymentResult(redirectUrl: string | null) {
	return { details: [], redirectUrl, status: "success" } satisfies NonNullable<Checkout["paymentResult"]>
}

/** Only the fields `orderOutcome` reads. */
function placed(order: { isPaid: boolean; status: string }) {
	return { id: 42, ...order } as Order
}

describe("resolveCheckoutRedirect", () => {
	it("uses the gateway's own destination when it supplies one", () => {
		const checkout = confirmed({ orderId: 42, orderKey: "wc_order_abc", paymentResult: paymentResult("https://psp.test/pay/42") })
		expect(resolveCheckoutRedirect(checkout, "/checkout/order-received")).toBe("https://psp.test/pay/42")
	})

	it("rebuilds the store's return URL when the gateway names nowhere", () => {
		const checkout = confirmed({ orderId: 42, orderKey: "wc_order_abc", paymentResult: paymentResult(null) })
		expect(resolveCheckoutRedirect(checkout, "/checkout/order-received")).toBe("/checkout/order-received?order_id=42&key=wc_order_abc")
	})

	it("merges into a successPath that already carries a query or a fragment", () => {
		const checkout = confirmed({ orderId: 42, orderKey: "wc_order_abc", paymentResult: paymentResult(null) })
		expect(resolveCheckoutRedirect(checkout, "/order-received?lang=de")).toBe("/order-received?lang=de&order_id=42&key=wc_order_abc")
		expect(resolveCheckoutRedirect(checkout, "/order-received#receipt")).toBe("/order-received?order_id=42&key=wc_order_abc#receipt")
	})

	it("names nowhere when the app passed no successPath", () => {
		const checkout = confirmed({ orderId: 42, orderKey: "wc_order_abc", paymentResult: paymentResult(null) })
		expect(resolveCheckoutRedirect(checkout)).toBeNull()
	})

	it("names nowhere when no order was placed to return to", () => {
		const checkout = confirmed({ orderId: null, orderKey: null, paymentResult: null })
		expect(resolveCheckoutRedirect(checkout, "/checkout/order-received")).toBeNull()
	})
})

describe("parseCheckoutReturn", () => {
	it("reads the order out of the query the store returned to", () => {
		expect(parseCheckoutReturn("?order_id=42&key=wc_order_abc")).toEqual({ key: "wc_order_abc", orderId: 42 })
	})

	it("reads a URLSearchParams a router already parsed", () => {
		const params = new URLSearchParams({ key: "wc_order_abc", order_id: "42" })
		expect(parseCheckoutReturn(params)).toEqual({ key: "wc_order_abc", orderId: 42 })
	})

	it("ignores parameters that are not part of the contract", () => {
		expect(parseCheckoutReturn("utm_source=email&order_id=42&key=wc_order_abc&ref=x")).toEqual({
			key: "wc_order_abc",
			orderId: 42,
		})
	})

	it("rejects a query missing either half", () => {
		expect(parseCheckoutReturn("order_id=42")).toBeNull()
		expect(parseCheckoutReturn("key=wc_order_abc")).toBeNull()
		expect(parseCheckoutReturn("")).toBeNull()
	})

	it("rejects an order id that is not a plain positive integer", () => {
		expect(parseCheckoutReturn("order_id=abc&key=wc_order_abc")).toBeNull()
		expect(parseCheckoutReturn("order_id=4.2&key=wc_order_abc")).toBeNull()
		expect(parseCheckoutReturn("order_id=1e3&key=wc_order_abc")).toBeNull()
		expect(parseCheckoutReturn("order_id=0&key=wc_order_abc")).toBeNull()
		expect(parseCheckoutReturn("order_id=-7&key=wc_order_abc")).toBeNull()
		expect(parseCheckoutReturn("order_id=99999999999999999999&key=wc_order_abc")).toBeNull()
	})
})

describe("orderOutcome", () => {
	it("reports a card or COD order the store calls paid", () => {
		expect(orderOutcome(placed({ isPaid: true, status: "processing" }))).toEqual({ orderId: 42, state: "paid" })
	})

	it("reports a bank transfer or cheque as still owing money", () => {
		expect(orderOutcome(placed({ isPaid: false, status: "on-hold" }))).toEqual({ orderId: 42, state: "awaiting_payment" })
	})

	it("reports a decline as failed", () => {
		expect(orderOutcome(placed({ isPaid: false, status: "failed" }))).toEqual({ orderId: 42, state: "failed" })
	})

	it("reports an abandoned off-site gateway as still owing money", () => {
		expect(orderOutcome(placed({ isPaid: false, status: "pending" }))).toEqual({ orderId: 42, state: "awaiting_payment" })
	})

	it("reports a status it does not recognise as still owing money rather than done", () => {
		expect(orderOutcome(placed({ isPaid: false, status: "awaiting-shipment" }))).toEqual({
			orderId: 42,
			state: "awaiting_payment",
		})
	})

	it("trusts the store's own paid answer over the status it came with", () => {
		expect(orderOutcome(placed({ isPaid: true, status: "awaiting-shipment" }))).toEqual({ orderId: 42, state: "paid" })
	})
})
