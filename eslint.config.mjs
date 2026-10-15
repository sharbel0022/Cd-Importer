import js from "@eslint/js";
import ts from "typescript-eslint";
import hooks from "eslint-plugin-react-hooks";
export default ts.config(
  { ignores: ["node_modules/**", ".next/**", "dist/**", ".translation-data/**"] },
  js.configs.recommended, ...ts.configs.recommended,
  { files: ["**/*.ts", "**/*.tsx"], plugins: { "react-hooks": hooks }, rules: {
    "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
    "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn",
  } },
);
