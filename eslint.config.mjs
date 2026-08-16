import eslint from "@eslint/js";
import prettier from "eslint-config-prettier";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettier,
  {
    files: ["**/*.js", "**/*.mjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["docker/mongodb/init-replica-set.js"],
    languageOptions: {
      globals: {
        db: "readonly",
        process: "readonly",
        rs: "readonly",
        sleep: "readonly",
      },
    },
  },
  {
    // Node dev-tool scripts: node globals, no type-checking.
    files: ["scripts/**/*.mjs", "scripts/*.js"],
    languageOptions: {
      globals: {
        process: "readonly",
        URL: "readonly",
        console: "readonly",
      },
    },
  },
  {
    // Browser dev console: browser globals, no type-checking.
    files: ["frontend/**/*.js"],
    languageOptions: {
      globals: {
        document: "readonly",
        localStorage: "readonly",
        performance: "readonly",
        crypto: "readonly",
        fetch: "readonly",
        prompt: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        Node: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setTimeout: "readonly",
      },
    },
    rules: {
      "no-unused-vars": "off",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-magic-numbers": "off",
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true },
      ],
    },
  },
);
