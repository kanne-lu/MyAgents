import { fileURLToPath } from 'node:url';
import { includeIgnoreFile } from '@eslint/compat';
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import eslintComments from 'eslint-plugin-eslint-comments';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import { defineConfig } from 'eslint/config';
import ts from 'typescript-eslint';

const gitignorePath = fileURLToPath(new URL('./.gitignore', import.meta.url));

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  {
    // Additional ignore patterns for build output and bundled resources
    ignores: ['**/out/**', '**/dist/**', '**/.vite/**', '**/coverage/**', '**/.eslintcache', 'bundled-skills/**', '**/sdk-shim/**']
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  prettier,
  {
    plugins: {
      'eslint-comments': eslintComments,
      react,
      'react-hooks': reactHooks
    }
  },
  {
    settings: {
      react: {
        version: 'detect'
      }
    }
  },
  // Renderer process (Browser + React environment)
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: import.meta.dirname,
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly'
      }
    },
    rules: {
      ...react.configs.recommended.rules,
      ...react.configs['jsx-runtime'].rules,
      ...reactHooks.configs.recommended.rules,
      'react/prop-types': 'off' // Using TypeScript for prop validation
    }
  },
  // Global rules for all files
  {
    rules: {
      // TypeScript rules
      'no-undef': 'off', // TypeScript handles this
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_'
        }
      ],
      // Prevent disabling no-explicit-any via inline comments — it hides real
      // type bugs behind `any`. Ban list extends below for ESM-targeted files
      // (which is everything except `src/cli/**`).
      'eslint-comments/no-restricted-disable': ['error', '@typescript-eslint/no-explicit-any']
    }
  },
  // ESM-targeted files (everything except the CJS-bundled CLI): forbid
  // `// eslint-disable-next-line @typescript-eslint/no-require-imports`.
  //
  // Why: bare `require()` in an ESM file throws `ReferenceError: require is
  // not defined` at runtime. The Bun→Node v0.2.0 migration accumulated 6+
  // sites where developers reached for `require()` (probably copy-paste from
  // legacy CJS code) and silenced the lint with a disable comment. Each one
  // was a latent crash waiting for the right code path. The MCP playwright
  // "initialization failed: require is not defined" regression in v0.2.0 was
  // caused by exactly this. ESM files MUST use static `import` or
  // `await import()` — never `require()`.
  {
    files: ['**/*.{ts,tsx,js,jsx,mjs,cjs}'],
    ignores: ['src/cli/**'],
    rules: {
      'eslint-comments/no-restricted-disable': [
        'error',
        '@typescript-eslint/no-explicit-any',
        '@typescript-eslint/no-require-imports'
      ]
    }
  },
  // CLI is bundled by esbuild with `--format=cjs` (see package.json:build:cli),
  // so `require()` runs in a real CJS context after bundling. Disable the rule
  // entirely for CLI files — relying on disable-next-line comments would force
  // every `require()` call site to carry boilerplate, and (per Codex review)
  // doesn't actually constitute a true exemption since the underlying rule
  // would still fire if a contributor forgot the comment.
  {
    files: ['src/cli/**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  // Structural guard: builtin MCP tool files MUST NOT eager-import the SDK
  // or zod at module top (value imports only — `import type { ... }` is
  // erased at compile time and is fine). Value imports from these modules
  // must be loaded inside `createXxxServer()` via `await import(...)` so
  // the Sidecar cold-start singleton-creation tax (~500-1000ms) stays
  // deferred. Enforces the "Pit of success" convention codified in
  // CLAUDE.md 补充禁止事项 and builtin-mcp-meta.ts header.
  //
  // Uses @typescript-eslint/no-restricted-imports (not the base rule) so
  // that `allowTypeImports: true` lets us keep type-only imports zero-cost.
  {
    files: ['src/server/tools/*.ts'],
    ignores: ['src/server/tools/builtin-mcp-registry.ts', 'src/server/tools/builtin-mcp-meta.ts'],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@anthropic-ai/claude-agent-sdk',
              message: "Value-import inside createXxxServer() via `await import('@anthropic-ai/claude-agent-sdk')`. `import type { ... }` at module top is OK. See CLAUDE.md 补充禁止事项.",
              allowTypeImports: true
            },
            {
              name: 'zod',
              message: "Value-import inside createXxxServer() via `await import('zod/v4')`. `import type { ... }` at module top is OK.",
              allowTypeImports: true
            },
            {
              name: 'zod/v4',
              message: "Value-import inside createXxxServer() via `await import('zod/v4')`. `import type { ... }` at module top is OK.",
              allowTypeImports: true
            }
          ]
        }
      ]
    }
  }
);
