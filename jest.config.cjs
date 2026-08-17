/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    roots: ['<rootDir>/tests'],
    testMatch: ['**/*.test.ts'],
    collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
    moduleFileExtensions: ['ts', 'js', 'json'],
    extensionsToTreatAsEsm: ['.ts'],
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    transformIgnorePatterns: ['/node_modules/(?!p-limit|yocto-queue|trading-signals)/'],
    transform: {
        '^.+\\.ts$': ['ts-jest', {
            useESM: true,
            tsconfig: {
                module: 'ESNext',
                isolatedModules: true,
            },
        }],
        // trading-signals ships ESM-only .js with no CJS build (8.x) - run its
        // output through ts-jest too (allowJs), matching how it already handles
        // .ts, instead of adding a second toolchain just for this one package.
        'node_modules/trading-signals/.+\\.js$': ['ts-jest', {
            useESM: true,
            tsconfig: {
                module: 'ESNext',
                isolatedModules: true,
                allowJs: true,
            },
        }],
    },
    testEnvironmentOptions: {
        customExportConditions: ['node', 'node-addons'],
    },
};
