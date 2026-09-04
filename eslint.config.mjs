import tseslint from 'typescript-eslint';

/**
 * Type-aware, because the rule worth having here needs types:
 * no-floating-promises. Nearly everything in this extension is an async command
 * handler, and a dropped promise there fails silently in the extension host.
 *
 * `tsc` already covers unused locals and implicit any, so this is deliberately
 * narrow rather than a second opinion on what the compiler already said.
 */
export default tseslint.config(
    {
        ignores: ['out/**', 'dist/**', '.vscode-test/**', 'node_modules/**', 'scripts/**', 'l10n/**']
    },
    ...tseslint.configs.recommended,
    {
        files: ['src/**/*.ts'],
        languageOptions: {
            parserOptions: {
                projectService: true,
                tsconfigRootDir: import.meta.dirname
            }
        },
        rules: {
            '@typescript-eslint/no-floating-promises': 'error',
            '@typescript-eslint/no-misused-promises': 'error',
            // The compiler reports these already, and duplicating them means
            // two different messages for one mistake.
            '@typescript-eslint/no-unused-vars': 'off'
        }
    }
);
