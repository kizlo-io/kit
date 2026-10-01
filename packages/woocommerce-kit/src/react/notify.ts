/**
 * One consumer listener, called without letting it break the phase it runs in.
 *
 * A thunk rather than a listener and its event, because that is the only shape general enough for all three adapters: the
 * search hook's listeners take two arguments, which `(listener, event)` cannot express.
 *
 * Around a mutation the isolation is load-bearing. React Query awaits `onMutate`, `onSuccess` and `onSettled` inside the same
 * `try` as the mutation function, so a throwing listener on the success path would otherwise be recorded as the mutation's own
 * failure: the action would report itself as failed, and hold the listener's error, after the store had already accepted it. The
 * failure is re-raised on its own instead, where it still reaches the app's error handling rather than disappearing.
 */
export function notify(listen: () => void) {
	try {
		listen()
	} catch (error) {
		queueMicrotask(() => {
			throw error
		})
	}
}
