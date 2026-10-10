import { atom } from "nanostores"

export type ReadinessRequest = Readonly<{ identity: object; feature: string; generation: number; confirmation: boolean }>
export type ReadinessFailure = Readonly<{
	identity: object
	feature: string
	task: string
	error: unknown
	sequence: number
	uncertain: boolean
}>
/** Request identities survive cache eviction; outcomes are ordered by observed completion, never start time. */
export function createCheckoutReadiness() {
	const pending = new Map<object, ReadinessRequest>()
	const failures = new Map<string, ReadinessFailure>()
	const unresolved = new Map<string, ReadinessFailure>()
	let sequence = 0
	const snapshot = () =>
		Object.freeze({
			pending: Object.freeze([...pending.values()]),
			failures: Object.freeze([...failures.values()]),
			unresolved: Object.freeze([...unresolved.values()]),
		})
	const state = atom(snapshot())
	const publish = () => state.set(snapshot())
	return {
		state: Object.freeze({ get: state.get, listen: state.listen }),
		start(request: ReadinessRequest) {
			if (pending.has(request.identity)) return
			pending.set(request.identity, request)
			publish()
		},
		finish(
			identity: object,
			feature: string,
			generation: number,
			currentGeneration: number,
			error: unknown,
			confirmation = false,
			outcome: { tasks?: readonly string[]; blocking?: boolean; uncertain?: boolean } = {},
		) {
			const { tasks = [feature], blocking = true, uncertain = false } = outcome
			pending.delete(identity)
			if (generation === currentGeneration && !confirmation) {
				const completed = error ? ++sequence : sequence
				for (const task of tasks) {
					if (error) {
						const failure = Object.freeze({ identity, feature, task, error, sequence: completed, uncertain })
						failures.set(task, failure)
						if (blocking) unresolved.set(task, failure)
					} else {
						failures.delete(task)
						unresolved.delete(task)
					}
				}
			}
			publish()
		},
		seedFailure(identity: object, feature: string, error: unknown) {
			const failure = Object.freeze({ identity, feature, task: feature, error, sequence: ++sequence, uncertain: true })
			failures.set(feature, failure)
			unresolved.set(feature, failure)
			publish()
		},
		dismiss(feature: string, identity?: object) {
			for (const [task, failure] of failures)
				if (failure.feature === feature && (!identity || identity === failure.identity)) failures.delete(task)
			publish()
		},
		resolve(task: string, identity?: object) {
			if (identity && unresolved.get(task)?.identity !== identity) return
			if (unresolved.delete(task)) publish()
		},
		acknowledge(task: string) {
			const failure = unresolved.get(task)
			if (failure?.uncertain) {
				unresolved.set(task, Object.freeze({ ...failure, uncertain: false }))
				publish()
			}
		},
		replaceSession() {
			failures.clear()
			unresolved.clear()
			// Already dispatched work can still change the server, even when its publication token is obsolete.
			publish()
		},
		failure(feature: string) {
			let latest: ReadinessFailure | undefined
			for (const failure of failures.values())
				if (failure.feature === feature && (!latest || failure.sequence > latest.sequence)) latest = failure
			return latest
		},
		reasons() {
			const reasons = new Map<string, string>()
			for (const request of pending.values()) reasons.set(request.feature, "Updating the checkout.")
			for (const failure of unresolved.values()) {
				const error = failure.error as { message?: string }
				reasons.set(failure.feature, error?.message ?? "Resolve the failed checkout task.")
			}
			return reasons
		},
	}
}
