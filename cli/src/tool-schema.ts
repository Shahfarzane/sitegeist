import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import { z } from "zod";

/** The bounds zod puts on every integer: true of any JSON number a client can send. */
function dropSafeIntegerBounds(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(dropSafeIntegerBounds);
	if (!node || typeof node !== "object") return node;
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node)) {
		if (key === "minimum" && value === Number.MIN_SAFE_INTEGER) continue;
		if (key === "maximum" && value === Number.MAX_SAFE_INTEGER) continue;
		out[key] = dropSafeIntegerBounds(value);
	}
	return out;
}

/**
 * Remove what zod's JSON Schema output adds that costs tokens and tells a model nothing:
 * the draft URL at the root and the safe-integer bounds on every integer.
 */
export function pruneSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const { $schema: _draft, ...rest } = schema;
	return dropSafeIntegerBounds(rest) as Record<string, unknown>;
}

/** A tool's input schema: zod validates the arguments, the pruned JSON Schema is what the client sees. */
export function toolInput<Shape extends z.ZodRawShape>(
	shape: Shape,
): StandardSchemaWithJSON<z.input<z.ZodObject<Shape>>, z.output<z.ZodObject<Shape>>> {
	const standard = z.object(shape)["~standard"];
	return {
		"~standard": {
			...standard,
			jsonSchema: {
				input: (options) => pruneSchema(standard.jsonSchema.input(options)),
				output: (options) => pruneSchema(standard.jsonSchema.output(options)),
			},
		},
	};
}
