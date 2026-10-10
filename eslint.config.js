import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    ignores: ['dist/**', 'coverage/**', 'site/**', 'eslint.config.js'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  {
    // Diagnostics reach stderr only through src/cli.ts, and stdout carries only what a command prints.
    files: ['src/**/*.ts'],
    rules: {
      'no-console': 'error',
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'stdout', message: 'Only src/cli.ts and src/server.ts use the process streams.' },
        { object: 'process', property: 'stderr', message: 'Only src/cli.ts and src/server.ts use the process streams.' },
      ],
    },
  },
  {
    files: ['src/cli.ts', 'src/server.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Only the MCP adapter and the entry points that start it may reach the MCP SDK or the adapter;
    // everything else, src/sdk.ts included, works without it.
    files: ['src/**/*.ts'],
    ignores: ['src/mcp/**', 'src/server.ts', 'src/cli.ts', 'src/index.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/mcp/**', '**/server.js', '@modelcontextprotocol/*'],
              message: 'Only src/mcp/, src/server.ts, src/cli.ts, and src/index.ts may import the MCP adapter or SDK.',
              allowTypeImports: false,
            },
          ],
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
    },
  }
)
