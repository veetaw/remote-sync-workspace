# Contributing

Use English for issues, pull requests, documentation, and user-facing strings.

1. Fork the repository and create a focused branch.
2. Install dependencies with `npm ci` using Node.js 22.12 or later.
3. Follow [DEVELOPMENT.md](DEVELOPMENT.md), including synchronization and recovery invariants.
4. Run `npm run check` and `npm run package` before opening a pull request. For changes to commands or VS Code integration, also run `npm run test:extension`; for packaging or publisher changes, run `npm run test:vsix` after packaging.
5. Describe the problem, resulting behavior, and checks performed. Add regression coverage for synchronization, persistence, or recovery changes.

Use disposable local servers and directories for tests. Test certificates and keys are public fixtures, not production credentials. Never include real connection details, passwords, private keys, or project content in issues or pull requests.

Report suspected vulnerabilities privately as described in [SECURITY.md](SECURITY.md).
