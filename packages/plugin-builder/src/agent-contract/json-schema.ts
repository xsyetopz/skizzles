import {
  AgentContractPackageError,
  CONTRACT_SCHEMA_VERSION,
  JSON_SCHEMA_DIALECT,
} from "./contract.ts";
import type { JsonValue } from "./json-value.ts";
import {
  assertArray,
  assertBoolean,
  assertInteger,
  assertRecord,
  assertString,
} from "./json-value.ts";

const SCHEMA_KEYWORDS = new Set([
  "$defs",
  "$id",
  "$ref",
  "$schema",
  "additionalProperties",
  "const",
  "description",
  "enum",
  "format",
  "items",
  "maxItems",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
  "prefixItems",
  "properties",
  "required",
  "title",
  "type",
]);

const JSON_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

export interface SchemaExpectation {
  id: string;
  requiredRootProperties: readonly string[];
  requiredSemanticPaths: readonly string[];
}

export function validateSchemaDocument(
  value: JsonValue,
  label: string,
  expectation: SchemaExpectation,
): void {
  const root = assertRecord(value, label);
  validateSchemaNode(root, label);

  if (root["$schema"] !== JSON_SCHEMA_DIALECT) {
    throw new AgentContractPackageError(
      `${label} must use JSON Schema draft 2020-12.`,
    );
  }
  if (root["$id"] !== expectation.id) {
    throw new AgentContractPackageError(
      `${label} has an unexpected or stale schema identifier.`,
    );
  }
  if (root["type"] !== "object" || root["additionalProperties"] !== false) {
    throw new AgentContractPackageError(
      `${label} root must be a closed object schema.`,
    );
  }

  const properties = assertRecord(root["properties"], `${label}.properties`);
  assertExactMembers(
    new Set(Object.keys(properties)),
    expectation.requiredRootProperties,
    `${label}.properties`,
  );
  const version = assertRecord(
    properties["schemaVersion"],
    `${label}.properties.schemaVersion`,
  );
  if (version["const"] !== CONTRACT_SCHEMA_VERSION) {
    throw new AgentContractPackageError(
      `${label} must require schemaVersion ${CONTRACT_SCHEMA_VERSION}.`,
    );
  }

  const required = stringSet(root["required"] ?? [], `${label}.required`);
  assertExactMembers(
    required,
    expectation.requiredRootProperties,
    `${label}.required`,
  );
  for (const path of expectation.requiredSemanticPaths) {
    schemaAtPath(root, path, label);
  }
}

function validateSchemaNode(
  schema: Record<string, JsonValue>,
  label: string,
): void {
  validateKnownKeywords(schema, label);
  validateScalarKeywords(schema, label);
  validateEnum(schema, label);
  validateObjectSchema(schema, label);
  validateChildSchemas(schema, label);
}

function validateKnownKeywords(
  schema: Record<string, JsonValue>,
  label: string,
): void {
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYWORDS.has(key)) {
      throw new AgentContractPackageError(
        `${label} contains unknown schema keyword ${key}.`,
      );
    }
  }
}

function validateScalarKeywords(
  schema: Record<string, JsonValue>,
  label: string,
): void {
  if (schema["$schema"] !== undefined) {
    assertString(schema["$schema"], `${label}.$schema`);
  }
  if (schema["$id"] !== undefined) {
    assertString(schema["$id"], `${label}.$id`);
  }
  if (schema["$ref"] !== undefined) {
    const reference = assertString(schema["$ref"], `${label}.$ref`);
    if (!reference.startsWith("#/$defs/")) {
      throw new AgentContractPackageError(
        `${label} may only use local definitions.`,
      );
    }
  }
  for (const key of ["title", "description", "format", "pattern"] as const) {
    if (schema[key] !== undefined) {
      assertString(schema[key], `${label}.${key}`);
    }
  }
  for (const key of ["maxItems", "minItems", "minLength", "minimum"] as const) {
    if (schema[key] !== undefined) {
      assertInteger(schema[key], `${label}.${key}`);
    }
  }
  if (schema["type"] !== undefined) {
    const type = assertString(schema["type"], `${label}.type`);
    if (!JSON_TYPES.has(type)) {
      throw new AgentContractPackageError(`${label}.type is unsupported.`);
    }
  }
  if (schema["required"] !== undefined) {
    stringSet(schema["required"], `${label}.required`);
  }
}

function validateEnum(schema: Record<string, JsonValue>, label: string): void {
  if (schema["enum"] !== undefined) {
    const values = assertArray(schema["enum"], `${label}.enum`);
    if (
      values.length === 0 ||
      new Set(values.map((value) => JSON.stringify(value))).size !==
        values.length
    ) {
      throw new AgentContractPackageError(
        `${label}.enum must contain unique values.`,
      );
    }
  }
}

function validateObjectSchema(
  schema: Record<string, JsonValue>,
  label: string,
): void {
  const properties = optionalSchemaMap(
    schema["properties"],
    `${label}.properties`,
  );
  if (schema["type"] === "object") {
    if (schema["additionalProperties"] !== false) {
      throw new AgentContractPackageError(
        `${label} object schema must set additionalProperties to false.`,
      );
    }
    const required = stringSet(schema["required"] ?? [], `${label}.required`);
    for (const requiredName of required) {
      if (!(requiredName in properties)) {
        throw new AgentContractPackageError(
          `${label}.required names missing property ${requiredName}.`,
        );
      }
    }
  } else if (schema["additionalProperties"] !== undefined) {
    assertBoolean(
      schema["additionalProperties"],
      `${label}.additionalProperties`,
    );
  }
}

function validateChildSchemas(
  schema: Record<string, JsonValue>,
  label: string,
): void {
  const properties = optionalSchemaMap(
    schema["properties"],
    `${label}.properties`,
  );
  for (const [name, child] of Object.entries(properties)) {
    validateSchemaNode(child, `${label}.properties.${name}`);
  }
  const definitions = optionalSchemaMap(schema["$defs"], `${label}.$defs`);
  for (const [name, child] of Object.entries(definitions)) {
    validateSchemaNode(child, `${label}.$defs.${name}`);
  }
  if (schema["items"] !== undefined && schema["items"] !== false) {
    validateSchemaNode(
      assertRecord(schema["items"], `${label}.items`),
      `${label}.items`,
    );
  }
  if (schema["prefixItems"] !== undefined) {
    const prefixItems = assertArray(
      schema["prefixItems"],
      `${label}.prefixItems`,
    );
    prefixItems.forEach((item, index) => {
      validateSchemaNode(
        assertRecord(item, `${label}.prefixItems[${index}]`),
        `${label}.prefixItems[${index}]`,
      );
    });
  }
}

function optionalSchemaMap(
  value: JsonValue | undefined,
  label: string,
): Record<string, Record<string, JsonValue>> {
  if (value === undefined) {
    return {};
  }
  const record = assertRecord(value, label);
  const result: Record<string, Record<string, JsonValue>> = {};
  for (const [name, item] of Object.entries(record)) {
    result[name] = assertRecord(item, `${label}.${name}`);
  }
  return result;
}

function stringSet(value: JsonValue, label: string): Set<string> {
  const values = assertArray(value, label).map((item, index) =>
    assertString(item, `${label}[${index}]`),
  );
  if (new Set(values).size !== values.length) {
    throw new AgentContractPackageError(`${label} contains duplicates.`);
  }
  return new Set(values);
}

function assertExactMembers(
  actual: ReadonlySet<string>,
  expected: readonly string[],
  label: string,
): void {
  if (
    actual.size !== expected.length ||
    expected.some((member) => !actual.has(member))
  ) {
    throw new AgentContractPackageError(
      `${label} must contain exactly ${expected.join(", ")}.`,
    );
  }
}

function schemaAtPath(
  root: Record<string, JsonValue>,
  path: string,
  label: string,
): Record<string, JsonValue> {
  let current = root;
  for (const segment of path.split(".")) {
    current = assertRecord(current[segment], `${label}.${path}`);
  }
  return current;
}
