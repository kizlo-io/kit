# @kizlo/kit

Shared primitives for the Kizlo component kits: the pieces every integration kit needs and none of them should own.

Install it only to use it directly; the kits depend on it themselves.

```bash
pnpm add @kizlo/kit
```

Peer dependency: `react` 19+, and only if you import `@kizlo/kit/react`. It is an optional peer, so a kit's framework-agnostic
core does not drag React into an app that uses another framework.

| Import | Contents |
| --- | --- |
| `@kizlo/kit` | `decodeHtmlEntities`, `assertKizloClient`. No framework. |
| `@kizlo/kit/react` | `KizloProvider`, `useKizloClient`. Carries `"use client"`. |

## `KizloProvider` and `useKizloClient`

Your Kizlo client is generated from your own WordPress introspection, so no kit can name its type. Mount it once and every
kit's client-side hooks read it from there — no client prop on a hook, no kit importing your client singleton:

```tsx
// app/providers.tsx
"use client"
import { KizloProvider } from "@kizlo/kit/react"
import { QueryClientProvider } from "@tanstack/react-query"
import { client } from "@/lib/kizlo/client"
import { queryClient } from "@/lib/query-client"

export function Providers({ children }) {
	return (
		<QueryClientProvider client={queryClient}>
			<KizloProvider client={client}>{children}</KizloProvider>
		</QueryClientProvider>
	)
}
```

Server components cannot read React context, so they keep taking the client as a prop. That is why a kit's server entry has a
`client` prop and its hooks do not.

A hook reads the slice it needs with `useKizloClient<T>(path)`, where `path` is the dotted procedure path it is about to call:

```tsx
const client = useKizloClient<CartStoreClient>("woocommerce.cart")
```

The generic is an assertion the compiler cannot check, so the check happens at runtime. A client built from an introspection
that does not include the integration fails here, naming what is absent —

```
Error: the client passed to <KizloProvider> has no woocommerce.cart procedures
```

— instead of a `Cannot read properties of undefined` from somewhere inside the request. `assertKizloClient(client, path)` is the
same check as a plain function, for a framework binding that has no React context to read.

Pass a second argument to use a client directly, for a test stub or a second store: `useKizloClient(path, stub)` needs no
provider.

## `decodeHtmlEntities(text)`

WordPress leaves entities in every `rendered` text field, so a product name arrives as `Kid&#8217;s bag`. Decode it before
putting it in a text node:

```tsx
import { decodeHtmlEntities } from "@kizlo/kit"

<h1>{decodeHtmlEntities(product.name)}</h1>
```

Rich content is different: that stays HTML and gets rendered as HTML.
