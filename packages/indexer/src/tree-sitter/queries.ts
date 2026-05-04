/**
 * Per-language symbol queries. Tree-sitter's query language captures named
 * nodes; we collect `@name` (symbol identifier) + `@kind` markers.
 *
 * Kept deliberately conservative — false positives are worse than missed
 * symbols because the symbol-lookup tool surfaces them directly to the model.
 */

import type { IndexedLanguage } from "../language-detect.ts";

export type SymbolKind =
  | "function"
  | "class"
  | "method"
  | "type"
  | "interface"
  | "struct"
  | "enum"
  | "trait"
  | "module"
  | "variable";

export interface SymbolQueryDef {
  /** Raw tree-sitter query string. Uses `@name.kind` capture naming. */
  query: string;
}

/**
 * We name captures `@name.<kind>` so the collector can infer kind from the
 * capture name without running parallel queries per kind.
 */
export const SYMBOL_QUERIES: Partial<Record<IndexedLanguage, SymbolQueryDef>> = {
  python: {
    query: `
      (function_definition name: (identifier) @name.function)
      (class_definition name: (identifier) @name.class)
    `,
  },
  typescript: {
    query: `
      (function_declaration name: (identifier) @name.function)
      (class_declaration name: (type_identifier) @name.class)
      (interface_declaration name: (type_identifier) @name.interface)
      (type_alias_declaration name: (type_identifier) @name.type)
      (enum_declaration name: (identifier) @name.enum)
      (method_definition name: (property_identifier) @name.method)
    `,
  },
  tsx: {
    query: `
      (function_declaration name: (identifier) @name.function)
      (class_declaration name: (type_identifier) @name.class)
      (interface_declaration name: (type_identifier) @name.interface)
      (type_alias_declaration name: (type_identifier) @name.type)
      (method_definition name: (property_identifier) @name.method)
    `,
  },
  javascript: {
    query: `
      (function_declaration name: (identifier) @name.function)
      (class_declaration name: (identifier) @name.class)
      (method_definition name: (property_identifier) @name.method)
    `,
  },
  rust: {
    query: `
      (function_item name: (identifier) @name.function)
      (struct_item name: (type_identifier) @name.struct)
      (enum_item name: (type_identifier) @name.enum)
      (trait_item name: (type_identifier) @name.trait)
      (impl_item type: (type_identifier) @name.class)
      (type_item name: (type_identifier) @name.type)
    `,
  },
  go: {
    query: `
      (function_declaration name: (identifier) @name.function)
      (method_declaration name: (field_identifier) @name.method)
      (type_declaration (type_spec name: (type_identifier) @name.type))
    `,
  },
  bash: {
    query: `
      (function_definition name: (word) @name.function)
    `,
  },
  c: {
    query: `
      (function_definition declarator: (function_declarator declarator: (identifier) @name.function))
      (struct_specifier name: (type_identifier) @name.struct)
    `,
  },
  cpp: {
    query: `
      (function_definition declarator: (function_declarator declarator: (identifier) @name.function))
      (class_specifier name: (type_identifier) @name.class)
      (struct_specifier name: (type_identifier) @name.struct)
    `,
  },
  ruby: {
    query: `
      (method name: (identifier) @name.method)
      (class name: (constant) @name.class)
      (module name: (constant) @name.module)
    `,
  },
  java: {
    query: `
      (class_declaration name: (identifier) @name.class)
      (interface_declaration name: (identifier) @name.interface)
      (method_declaration name: (identifier) @name.method)
    `,
  },
  ocaml: {
    query: `
      (value_definition (let_binding pattern: (value_name) @name.function))
      (type_definition (type_binding name: (type_constructor) @name.type))
      (module_definition (module_binding name: (module_name) @name.module))
    `,
  },
};

/** Parse a tree-sitter capture name ("name.function") → SymbolKind. */
export function kindFromCapture(captureName: string): SymbolKind | undefined {
  const parts = captureName.split(".");
  const kind = parts[1];
  switch (kind) {
    case "function":
    case "class":
    case "method":
    case "type":
    case "interface":
    case "struct":
    case "enum":
    case "trait":
    case "module":
    case "variable":
      return kind;
    default:
      return undefined;
  }
}
