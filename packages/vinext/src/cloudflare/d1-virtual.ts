import path from "node:path";

export const VIRTUAL_D1_DATABASES = "vinext:d1";
export const VIRTUAL_D1_OBJECT_EXPORTS = "virtual:vinext-d1-objects";

export type VinextD1PartitionConfig = "default" | "hostname";

export type VinextD1WritesConfig = {
  methods?: readonly string[];
  routes?: readonly string[];
};

export type VinextD1DatabaseConfig = {
  /**
   * Module containing the database-object implementation. The first runtime
   * slice uses this as the user-facing source of truth and future generated
   * type output can import it for precise method inference.
   */
  source: string;
  /** Advanced escape hatch; defaults to VINEXT_D1_<DATABASE_NAME>. */
  binding?: string;
  /** How incoming requests map to logical SQLite-backed databases. */
  partitionBy?: VinextD1PartitionConfig;
  /** Bookmark transport. Defaults to cookie so full-page navigations work. */
  bookmark?: "cookie" | "header" | false;
  /** Routes and HTTP methods that should go straight to the primary object. */
  writes?: VinextD1WritesConfig;
  /** Advanced escape hatch for non-Drizzle object session adapters. */
  rpcMethod?: string;
};

export type VinextD1Config = Record<string, VinextD1DatabaseConfig>;

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

export function generateD1DatabasesModule(config?: VinextD1Config): string {
  const entries = Object.entries(config ?? {});
  if (entries.length === 0) {
    return [
      "// vinext: no d1 databases configured.",
      "const databases = Object.freeze(Object.create(null));",
      "export default databases;",
      "",
    ].join("\n");
  }

  const lines: string[] = [
    "// vinext: generated from the `d1` option in your vinext() plugin config.",
    'import { createVinextD1DatabaseClient } from "vinext/cloudflare/d1";',
    "",
    "const databases = Object.create(null);",
  ];

  for (const [name, database] of entries) {
    validateDatabaseName(name);
    validateDatabaseConfig(name, database);
    const runtimeConfig = normalizeRuntimeConfig(name, database);
    lines.push(
      `// source: ${database.source}`,
      `export const ${name} = createVinextD1DatabaseClient(${JSON.stringify(
        name,
      )}, ${JSON.stringify(runtimeConfig)});`,
      `databases[${JSON.stringify(name)}] = ${name};`,
    );
  }

  lines.push("", "export default Object.freeze(databases);", "");
  return lines.join("\n");
}

export function generateD1ObjectExportsModule(
  config?: VinextD1Config,
  root = process.cwd(),
): string {
  const entries = Object.entries(config ?? {});
  if (entries.length === 0) {
    return ["// vinext: no d1 object exports configured.", "export {};", ""].join("\n");
  }

  const lines: string[] = ["// vinext: generated Durable Object exports from the `d1` option."];
  const sources = new Set<string>();
  for (const [name, database] of entries) {
    validateDatabaseName(name);
    validateDatabaseConfig(name, database);
    sources.add(resolveD1SourceSpecifier(database.source, root));
  }
  for (const source of sources) {
    lines.push(`export * from ${JSON.stringify(source)};`);
  }
  lines.push("");
  return lines.join("\n");
}

export function defaultD1BindingName(name: string): string {
  const normalized = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return `VINEXT_D1_${normalized || "DATABASE"}`;
}

function normalizeRuntimeConfig(name: string, database: VinextD1DatabaseConfig) {
  return {
    binding: database.binding ?? defaultD1BindingName(name),
    bookmark: database.bookmark ?? "cookie",
    partitionBy: database.partitionBy ?? "default",
    ...(database.rpcMethod ? { rpcMethod: database.rpcMethod } : {}),
    ...(database.writes ? { writes: database.writes } : {}),
  };
}

function validateDatabaseName(name: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(`[vinext] d1 database key "${name}" must be a valid JavaScript export name.`);
  }
}

function validateDatabaseConfig(name: string, database: VinextD1DatabaseConfig): void {
  if (!database || typeof database !== "object") {
    throw new Error(`[vinext] d1.${name} must be an object.`);
  }
  if (typeof database.source !== "string" || database.source.length === 0) {
    throw new Error(`[vinext] d1.${name}.source must be a non-empty module specifier.`);
  }
  if (
    database.partitionBy !== undefined &&
    database.partitionBy !== "default" &&
    database.partitionBy !== "hostname"
  ) {
    throw new Error(`[vinext] d1.${name}.partitionBy must be "default" or "hostname".`);
  }
  if (
    database.bookmark !== undefined &&
    database.bookmark !== "cookie" &&
    database.bookmark !== "header" &&
    database.bookmark !== false
  ) {
    throw new Error(`[vinext] d1.${name}.bookmark must be "cookie", "header", or false.`);
  }
  if (database.binding !== undefined && !IDENTIFIER_RE.test(database.binding)) {
    throw new Error(`[vinext] d1.${name}.binding must be a valid JavaScript identifier.`);
  }
  if (database.rpcMethod !== undefined && !IDENTIFIER_RE.test(database.rpcMethod)) {
    throw new Error(`[vinext] d1.${name}.rpcMethod must be a valid JavaScript identifier.`);
  }
  if (database.writes?.methods?.some((method) => typeof method !== "string")) {
    throw new Error(`[vinext] d1.${name}.writes.methods must be an array of strings.`);
  }
  if (database.writes?.routes?.some((route) => typeof route !== "string")) {
    throw new Error(`[vinext] d1.${name}.writes.routes must be an array of strings.`);
  }
}

function resolveD1SourceSpecifier(source: string, root: string): string {
  if (source.startsWith("./") || source.startsWith("../")) {
    return normalizePath(path.resolve(root, source));
  }
  if (path.isAbsolute(source)) {
    return normalizePath(source);
  }
  return source;
}

function normalizePath(filePath: string): string {
  return filePath.replace(/\\/g, "/");
}
