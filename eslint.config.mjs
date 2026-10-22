import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * Server lint config.
 *
 * Type-aware rules are on (`recommendedTypeChecked`): the rules that catch
 * real bugs in an async Express codebase — floating promises, unsafe `any`
 * propagation, misused promises in middleware — all need type information.
 */
export default tseslint.config(
  { ignores: ['dist/**', 'drizzle/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // An unawaited promise in a request handler is a silent 500.
      '@typescript-eslint/no-floating-promises': 'error',
      // Passing an async function where a void callback is expected means
      // rejections vanish — the classic Express middleware footgun.
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Drizzle and Zod return precise types; an explicit `any` is a smell.
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    // Scripts are run by hand and may log freely.
    files: ['src/scripts/**', 'src/db/migrate.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    /*
     * Test files.
     *
     * `node:test`'s `test()` and `describe()` return promises that the runner
     * itself awaits — callers are not meant to. `no-floating-promises` is
     * right about request handlers and wrong about this, so it is disabled
     * here rather than littering every test with `void`.
     *
     * Non-null assertions are also fine in a test: `toc[0]!` fails loudly on
     * the next line if the assumption is wrong, which is exactly what a test
     * should do.
     */
    files: ['src/**/*.test.ts'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  }
)
