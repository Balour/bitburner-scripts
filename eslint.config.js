import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default tseslint.config(
  {
    // The game writes NetscriptDefinitions.d.ts here; eslint does not read .gitignore.
    ignores: ['dist/**', '**/NetscriptDefinitions.d.ts'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  // Must stay last: it disables the stylistic rules prettier owns.
  prettierRecommended,
  {
    // Netscript runs in the game's browser context.
    files: ['src/**/*.{ts,tsx,js,jsx}'],
    languageOptions: { globals: globals.browser },
    rules: {
      // Daemon loops are intentionally `while (true)`.
      'no-constant-condition': 'off',
    },
  },
  {
    // The build config is Node.
    files: ['vite.config.ts'],
    languageOptions: { globals: globals.node },
  },
);
