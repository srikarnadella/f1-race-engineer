const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['node_modules/', '.venv/', 'coverage/', 'captures/', 'data/', 'notes/', 'site/', 'demo/'] },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs', globals: { ...globals.node } },
    rules: { 'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', ignoreRestSiblings: true }] },
  },
  // The dashboard runs in the browser, and its files also export for the Node tests.
  { files: ['public/**/*.js'], languageOptions: { globals: { ...globals.browser, ...globals.node } } },
];
