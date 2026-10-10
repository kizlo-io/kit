import type { CheckoutFieldsFetchFailure } from "./types"

/** Keep every failed source and the original SDK errors, including their code and data. */
export class CheckoutFieldsAcquisitionError extends Error {
	readonly failures: readonly CheckoutFieldsFetchFailure[]
	readonly cause: CheckoutFieldsFetchFailure["error"]
	readonly source: CheckoutFieldsFetchFailure["source"]
	constructor(failures: readonly [CheckoutFieldsFetchFailure, ...CheckoutFieldsFetchFailure[]]) {
		super(failures[0].error.message)
		this.name = "CheckoutFieldsAcquisitionError"
		this.failures = failures
		this.cause = failures[0].error
		this.source = failures[0].source
	}
	get code() {
		return this.cause.code
	}
	get data() {
		return this.cause.data
	}
}
