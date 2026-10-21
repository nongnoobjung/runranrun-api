/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
          target: 'es2022',
        },
      },
    ],
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  globalTeardown: '<rootDir>/test/global-teardown.ts',
  testTimeout: 30_000,
};
