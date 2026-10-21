// typescript-eslint (and its helpers) need the TypeScript compiler JS API, which TypeScript 7 (the native compiler)
// does not ship and typescript-eslint rejects. The application is compiled with `typescript` 7; these linting
// packages are resolved against the official side-by-side TypeScript 6 package instead. Drop this hook once
// typescript-eslint supports TypeScript 7 (https://github.com/typescript-eslint/typescript-eslint/issues/10940).
const tsApiPackages = new Set([
  'typescript-eslint',
  'ts-api-utils',
  '@typescript-eslint/eslint-plugin',
  '@typescript-eslint/parser',
  '@typescript-eslint/project-service',
  '@typescript-eslint/tsconfig-utils',
  '@typescript-eslint/type-utils',
  '@typescript-eslint/typescript-estree',
  '@typescript-eslint/utils',
]);

function readPackage(pkg) {
  if (tsApiPackages.has(pkg.name) && pkg.peerDependencies?.typescript) {
    delete pkg.peerDependencies.typescript;
    if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta.typescript;
    pkg.dependencies = { ...pkg.dependencies, typescript: 'npm:@typescript/typescript6@6.0.2' };
  }
  return pkg;
}

module.exports = { hooks: { readPackage } };
