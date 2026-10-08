import { expectTypeOf } from "vitest"
import type { CheckoutLockEntry, CheckoutLockState } from "../src/checkout-locks"
import type * as kit from "../src/index"
import type { CheckoutDependency, CheckoutHookOptions } from "../src/react/checkout"

const options: CheckoutHookOptions = {
	dependencies: [
		{ keys: ["inventory", { location: "store" }], type: "query" },
		{ keys: ["promotion"], type: "mutation", block: { onError: false } },
		{ keys: ["reserveInventory"], type: "mutation", block: { onPending: false, onError: true } },
	] as const,
	onSuccess: ({ checkout }) => {
		expectTypeOf(checkout.orderId).toEqualTypeOf<number | null>()
	},
}
expectTypeOf<CheckoutHookOptions["dependencies"]>().toEqualTypeOf<readonly CheckoutDependency[] | undefined>()
expectTypeOf<CheckoutDependency["keys"]>().toEqualTypeOf<readonly unknown[]>()
expectTypeOf<CheckoutDependency["type"]>().toEqualTypeOf<"query" | "mutation">()
// @ts-expect-error Registered keys are readonly.
options.dependencies?.push({ keys: ["other"], type: "query" })
// @ts-expect-error Key segments are readonly too.
options.dependencies?.[0]?.keys.push("request")
const dependency = options.dependencies?.[0]
if (dependency) {
	// @ts-expect-error Dependency fields are readonly.
	dependency.type = "mutation"
}
const block = options.dependencies?.[1]?.block
if (block) {
	// @ts-expect-error Policy flags are readonly.
	block.onError = true
}
// @ts-expect-error Query selectors belong in dependencies.
const _flatQueries: CheckoutHookOptions = { queryKeys: [["inventory"]] }
// @ts-expect-error Mutation selectors belong in dependencies.
const _flatMutations: CheckoutHookOptions = { mutationKeys: [["reserveInventory"]] }
// @ts-expect-error The old readiness group is not supported.
const _oldReadiness: CheckoutHookOptions = { readiness: { queryKeys: [["inventory"]] } }
// @ts-expect-error Every dependency identifies its cache type.
const _missingType: CheckoutDependency = { keys: ["inventory"] }
// @ts-expect-error Only query and mutation caches are supported.
const _invalidType: CheckoutDependency = { keys: ["inventory"], type: "request" }
// @ts-expect-error Policy flags are boolean.
const _invalidPolicy: CheckoutDependency = { keys: ["inventory"], type: "query", block: { onError: "false" } }
expectTypeOf<"createCheckoutLockStore" extends keyof typeof kit ? true : false>().toEqualTypeOf<false>()
expectTypeOf<"checkoutLockStore" extends keyof typeof kit ? true : false>().toEqualTypeOf<false>()
expectTypeOf<CheckoutLockState["entries"]>().toEqualTypeOf<readonly CheckoutLockEntry[]>()
