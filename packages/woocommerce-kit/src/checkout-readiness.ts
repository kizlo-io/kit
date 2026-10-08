import { atom } from "nanostores"

export type ReadinessRequest = Readonly<{ identity: object; feature: string; generation: number; confirmation: boolean }>
export type ReadinessFailure = Readonly<{ identity: object; feature: string; error: unknown; sequence: number }>
/** Request identities survive cache eviction; outcomes are ordered by observed completion, never start time. */
export function createCheckoutReadiness() {
	const pending = new Map<object, ReadinessRequest>()
	const failures = new Map<string, ReadinessFailure>()
	let sequence = 0
	const snapshot = () => Object.freeze({ pending: Object.freeze([...pending.values()]), failures: Object.freeze([...failures.values()]) })
	const state = atom(snapshot())
	const publish = () => state.set(snapshot())
	return {
		state: Object.freeze({ get: state.get, listen: state.listen }),
		start(request: ReadinessRequest) {
			if (pending.has(request.identity)) return
			pending.set(request.identity, request)
			publish()
		},
		finish(identity: object, feature: string, generation: number, currentGeneration: number, error: unknown, confirmation = false) {
			pending.delete(identity)
			if (generation === currentGeneration && !confirmation) {
				if (error) failures.set(feature, Object.freeze({ identity, feature, error, sequence: ++sequence }))
				else failures.delete(feature)
			}
			publish()
		},
		seedFailure(identity: object, feature: string, error: unknown) {
			failures.set(feature, Object.freeze({ identity, feature, error, sequence: ++sequence }))
			publish()
		},
		dismiss(feature: string, identity?: object) {
			if (identity && failures.get(feature)?.identity !== identity) return
			if (failures.delete(feature)) publish()
		},
		replaceSession() {
			failures.clear()
			// Already dispatched work can still change the server, even when its publication token is obsolete.
			publish()
		},
		failure(feature: string) {
			return failures.get(feature)
		},
		reasons() {
			const reasons = new Map<string, string>()
			for (const request of pending.values()) reasons.set(request.feature, "Updating the checkout.")
			for (const failure of failures.values()) {
				const error = failure.error as { message?: string }
				reasons.set(failure.feature, error?.message ?? "Resolve the failed checkout task.")
			}
			return reasons
		},
	}
}
