import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // examples/ holds CAP projects (CommonJS, CAP globals such as SELECT); they are linted by cds, not here.
  { ignores: ["dist/**", "node_modules/**", "examples/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["scripts/**/*.ts", "src/cli.ts"],
    rules: { "no-console": "off" },
  },
);
