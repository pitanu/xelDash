// ESLint (npm run lint): mistakes only, such as unused or undefined names and unreachable code. No style rules, so nothing is
// reformatted; the code's own style stays as it is.
import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  { ignores: ["**/node_modules/", "web/dist/", "packages/xelis-hash/target/", "notes/", "backups/"] },
  js.configs.recommended,
  {
    languageOptions: { ecmaVersion: "latest", sourceType: "module", globals: globals.node },
    rules: {
      // A leading underscore marks a parameter or variable kept on purpose; a caught error may go unused.
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
    },
  },
  {
    files: ["web/src/**/*.{js,jsx}"],
    languageOptions: { globals: globals.browser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" },
  },
  { files: ["web/public/**/*.js"], languageOptions: { sourceType: "script", globals: globals.browser } },
  {
    files: ["web/test/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
];
