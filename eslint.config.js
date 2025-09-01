/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import stylistic from "@stylistic/eslint-plugin";
import importPlugin from "eslint-plugin-import";
import globals from "globals";

export default tseslint.config(
    {
        // Global ignores
        ignores: ["node_modules/*", "dist/**"],
    },
    eslint.configs.recommended,
    ...tseslint.configs.recommended,
    {
        // General overrides and rules for the project (TS files)
        files: ["src/**/*.ts"],
        plugins: {
            import: importPlugin,
            "@stylistic": stylistic,
        },
        settings: {
            "import/resolver": {
                node: true,
            },
        },
        languageOptions: {
            globals: {
                ...globals.node,
                ...globals.es2021,
            },
        },
        rules: {
            // General Best Practice Rules
            "@typescript-eslint/array-type": ["error", { default: "array-simple" }],
            "arrow-body-style": ["error", "as-needed"],
            curly: ["error", "multi-line"],
            eqeqeq: ["error", "always", { null: "ignore" }],
            "@typescript-eslint/no-explicit-any": "error",
            "@typescript-eslint/no-unused-vars": [
                "error",
                {
                    argsIgnorePattern: "^_",
                    varsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_",
                },
            ],
            "no-var": "error",
            "object-shorthand": "error",
            "prefer-const": ["error", { destructuring: "all" }],
            "default-case": "error",
            "@stylistic/quotes": ["error", "double"],
            "@stylistic/array-bracket-spacing": ["error", "never"],
            "@stylistic/object-curly-spacing": ["error", "never"],
            "@stylistic/indent": ["error", 4],
            "@stylistic/semi": "error",
        },
    },
);
