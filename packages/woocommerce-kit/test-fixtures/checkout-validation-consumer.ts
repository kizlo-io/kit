import type { Checkout, woocommerce } from "@kizlo/woocommerce"
import type { InferProcedureInput, Procedure, RootProcedures, schemaType } from "kizlo"
import type { CheckoutCallbacks, CheckoutErrorEvent } from "../src/checkout"
import type { CheckoutApi } from "../src/react/checkout"
import type { CheckoutError } from "../src/types"

type Evidence = { source: string | null; sourcePath: string[]; code: string | null; message: string }
type ValidationIssue = Evidence &
	({ scope: "field"; target: string[] } | { scope: "group"; target: string[] } | { scope: "unresolved"; target: null })
type ValidationData = { issues: ValidationIssue[] }
type Base = RootProcedures<[ReturnType<typeof woocommerce>]>
type CheckoutProcedures = Base["woocommerce"]["checkout"]
// A consumer can register its own error schema; Kit must retain it without importing an SDK payload type.
type Confirm = Procedure<
	"api",
	InferProcedureInput<CheckoutProcedures["confirm"]>,
	Checkout,
	{
		CHECKOUT_VALIDATION_FAILED: { status: 400; data: ReturnType<typeof schemaType<ValidationData>> }
	}
>
type Consumer = Omit<Base, "woocommerce"> & {
	woocommerce: Omit<Base["woocommerce"], "checkout"> & {
		checkout: Omit<CheckoutProcedures, "confirm"> & { confirm: Confirm }
	}
}
declare module "kizlo" {
	interface KizloProcedureRegistry {
		procedures: Consumer
	}
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false
type Assert<T extends true> = T
type Payload = Extract<CheckoutError, { code: "CHECKOUT_VALIDATION_FAILED" }>["data"]
export type PayloadKeys = Assert<Equal<keyof Payload, "issues">>
export type EventPayload = Assert<Equal<Extract<CheckoutErrorEvent["error"], { code: "CHECKOUT_VALIDATION_FAILED" }>["data"], Payload>>

declare const error: CheckoutError
if (error.code === "CHECKOUT_VALIDATION_FAILED") {
	const data = error.data
	const expected: ValidationData = data
	// @ts-expect-error The legacy dictionary is not part of the issues-only contract.
	const fields = data.fields
	// @ts-expect-error Raw WooCommerce payloads are not public validation data.
	const upstream = data.upstream
	for (const issue of data.issues) {
		const source: string | null = issue.source
		const sourcePath: string[] = issue.sourcePath
		const code: string | null = issue.code
		if (issue.scope === "field" || issue.scope === "group") {
			const target: string[] = issue.target
			void target
		}
		if (issue.scope === "unresolved") {
			const target: null = issue.target
			void target
		}
		// @ts-expect-error Literal path arrays cannot be used as dotted form names.
		const dotted: string = issue.target
		void [source, sourcePath, code, dotted]
	}
	void [expected, fields, upstream]
}
declare const event: CheckoutErrorEvent
if (event.error.code === "CHECKOUT_VALIDATION_FAILED") {
	const data: ValidationData = event.error.data
	void data
}
const onError: NonNullable<CheckoutCallbacks["onError"]> = (event) => {
	if (event.error.code === "CHECKOUT_VALIDATION_FAILED") {
		const data: ValidationData = event.error.data
		void data
	}
}
declare const api: CheckoutApi
if (api.error?.code === "CHECKOUT_VALIDATION_FAILED") {
	const data: ValidationData = api.error.data
	void data
}
void onError
