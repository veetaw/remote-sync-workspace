import js from '@eslint/js';
import ts from 'typescript-eslint';
export default ts.config({ ignores: ['dist/**', 'node_modules/**', '.research/**', '.vscode-test/**'] }, js.configs.recommended, ...ts.configs.recommended, { rules: { '@typescript-eslint/no-explicit-any': 'error', 'no-control-regex': 'off' } });
