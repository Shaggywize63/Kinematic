/**
 * Jest config for the Kinematic backend integration/E2E suite.
 *
 * - ts-jest transforms the TypeScript sources (CommonJS, matching tsconfig).
 * - `tests/setupEnv.ts` runs before any module import so the Supabase env
 *   vars projects.ts asserts at load time are present (the real Supabase is
 *   never dialed — it's mocked or bypassed via the demo token).
 * - `@/*` path alias mirrors tsconfig so app modules resolve under Jest.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  setupFiles: ['<rootDir>/tests/setupEnv.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // `jose` is ESM-only; the CJS Jest runtime can't require it. No test needs
    // real JWT crypto (HTTP E2E uses the demo-token bypass), so stub it.
    '^jose$': '<rootDir>/tests/helpers/joseStub.ts',
  },
  clearMocks: true,
  // The app spins up background pollers/intervals only in server.ts (never
  // imported here) — but keep Jest from hanging on any stray handle.
  testTimeout: 20000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { isolatedModules: true, diagnostics: false }],
  },
};
