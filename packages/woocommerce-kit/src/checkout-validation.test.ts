import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { expect, test } from "vitest"

const PACKAGE = fileURLToPath(new URL("../", import.meta.url))

test("an issues-only registered consumer retains validation data through errors and callbacks", () => {
	const configPath = path.join(PACKAGE, "tsconfig.json")
	const config = ts.readConfigFile(configPath, ts.sys.readFile)
	const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, PACKAGE, undefined, configPath)
	// Compile a separate consumer program: this fixture registers its own client rather than this repo's SDK registry.
	const program = ts.createProgram([path.join(PACKAGE, "test-fixtures/checkout-validation-consumer.ts")], {
		...parsed.options,
		incremental: false,
		tsBuildInfoFile: undefined,
		noEmit: true,
	})
	expect(
		[...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
			ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
		),
	).toEqual([])
})
