# GitHub setup and Marketplace publishing

## Repository identity

- **Repository:** `veetaw/remote-sync-workspace`
- **Display name:** Remote Sync Workspace
- **Extension name:** `remote-sync-workspace`
- **GitHub description:** Persistent FTP, FTPS, and SFTP workspaces for VS Code with verified sync, conflict resolution, and private Git history.
- **Suggested topics:** `vscode-extension`, `ftp`, `ftps`, `sftp`, `file-sync`, `remote-development`, `typescript`

The manifest already points to this GitHub repository. These links become live once the repository is created and pushed. The current publisher `remote-sync-local` is a local development identifier; it is not evidence of a registered Marketplace publisher.

## 1. Create the GitHub repository

On [GitHub's new repository page](https://github.com/new), select owner **veetaw**, name **remote-sync-workspace**, and paste the description above. Choose visibility; public is suitable for this MIT-licensed project. Create an **empty** repository: do not generate a README, license, or .gitignore, because this project includes them.

From the project directory in PowerShell:

```powershell
git status --short
git add .
git diff --cached --stat
git commit -m "Prepare Remote Sync Workspace for release"
git branch -M main
git remote add origin https://github.com/veetaw/remote-sync-workspace.git
git push -u origin main
```

The project already has an initialized Git repository. These commands assume the first commit and no existing `origin`; inspect `git remote -v` first if you have changed the setup. If an origin exists, verify it before changing it. Git may prompt you to authenticate through Git Credential Manager.

Alternatively, if you have [GitHub CLI](https://cli.github.com/) installed and authenticated, after committing and naming the branch `main`:

```powershell
gh auth login
gh repo create veetaw/remote-sync-workspace --public --source . --remote origin --push --description "Persistent FTP, FTPS, and SFTP workspaces for VS Code with verified sync, conflict resolution, and private Git history."
```

Use either the website route or CLI creation route. The CLI command creates a public repository; use `--private` if that is your intended visibility.

In repository settings, add topics and enable **Private vulnerability reporting** under **Settings → Security → Code security** (GitHub may group it under advanced security settings). Confirm that Actions is enabled. The included Verify workflow builds, lints, tests, and packages on Windows, Linux, and macOS, then retains VSIX artifacts. It does not publish to the Marketplace.

## 2. Create your Marketplace publisher

1. Open [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage).
2. Sign in with your Microsoft account.
3. Choose **Create publisher**.
4. Use `veetaw` as the publisher ID if it is available, or choose another ID you control. A GitHub username does not reserve the matching Marketplace ID.
5. Choose your publisher display name and complete the required fields.
6. Set the exact registered publisher ID in `package.json`:

```powershell
npm pkg set publisher=YOUR_REGISTERED_PUBLISHER_ID
```

Replace `YOUR_REGISTERED_PUBLISHER_ID` before running the command. The extension's identity will be `<publisher>.remote-sync-workspace`. Keep that identity stable after the first publication. The configuration generator preserves the manifest's version and publisher values.

## 3. Build, verify, and package

Use Node.js **22.12+**, npm, and Git from the project directory:

```powershell
npm ci
npm run check
npm run package
```

`check` runs the TypeScript build, ESLint, and automated tests. Packaging runs the prepublish hook, rebuilds the bundle, generates third-party notices, and creates `remote-sync-workspace-<version>.vsix` using the version in `package.json`. It does not upload anything.

Inspect the package file list:

```powershell
npx --no-install vsce ls --no-dependencies
```

The package should contain the manifest, bundled runtime, resources, license, notices, and documentation. Source tests, local test servers, fixture keys, logs, node_modules, and GitHub workflows are excluded. Runtime dependencies are already bundled with esbuild, so packaging uses `--no-dependencies`.

Install the newly generated VSIX using **Extensions → … → Install from VSIX…**, or:

```powershell
$extensionVersion = node -p "require('./package.json').version"
code --install-extension "remote-sync-workspace-$extensionVersion.vsix"
```

Test a disposable connection, downloading, save-to-upload, conflict handling, and history restore. The automated integration checks are:

```powershell
npm run test:extension
npm run test:vsix
```

The VSIX check needs a local VS Code executable; set `VSCODE_EXECUTABLE` if discovery fails. It installs only in an isolated test profile. If PHP compatibility matters, also run `npm run test:php`, which downloads Intelephense into an isolated profile.

Before publishing, confirm the registered publisher, version, license, English README/changelog, and repository links. A PNG Marketplace icon and real screenshots are useful presentation improvements; the existing SVG is an Activity Bar icon and must not be assigned as the Marketplace `icon`.

## 4. Publish the first version

The simplest first release is a manual upload of the exact VSIX you just tested:

1. Open [publisher management](https://marketplace.visualstudio.com/manage) and select your publisher.
2. Choose **New extension → Visual Studio Code**.
3. Upload the VSIX created **after** setting your real publisher ID.
4. Follow the Marketplace validation process and resolve any reported issues.
5. Open the listing and install the published version in VS Code.

The listing URL will be `https://marketplace.visualstudio.com/items?itemName=<publisher>.remote-sync-workspace`. The README provides the listing's main description, while the manifest's `description` supplies its short summary.

## 5. Optional automated publishing

The included `.github/workflows/publish.yml` is **manually triggered** and uses GitHub OIDC Trusted Publishing. It does not run on pushes or tags. Configure it before use:

1. In Marketplace publisher management, open your publisher's **Trusted Publishing** settings.
2. Create a policy with owner `veetaw`, repository `remote-sync-workspace`, workflow `publish.yml`, and no environment (the workflow does not declare one).
3. Ensure your real publisher ID is committed to `package.json`.
4. Push the workflow to the default branch.
5. Open **Actions → Publish to Marketplace → Run workflow**, select the default branch, and run it for a new, unpublished manifest version.

The workflow checks the project, packages it, and publishes that VSIX using `vsce publish --oidc --packagePath`. Its publishing job grants `id-token: write`; no Marketplace token needs to be stored in GitHub secrets. The workflow rejects the local development publisher.

Microsoft's current guidance recommends federated identity. Its documentation states that global Azure DevOps Personal Access Tokens retire on **December 1, 2026**; avoid starting a new release process around global PATs. See the [official publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) for current account and authentication requirements.

## 6. Release updates

1. Update the changelog.
2. Bump the version, for example `npm version patch --no-git-tag-version`. This updates the manifest and lockfile.
3. Run checks, package, and test the resulting VSIX.
4. Commit the changes and push them.
5. Upload the new VSIX through the existing Marketplace extension's update action, or run the configured publishing workflow.
6. Optionally create a Git tag and GitHub Release, attaching the same VSIX.

Every published update needs a new version number. Changing only documentation still requires a new Marketplace version when distributing a new VSIX. A GitHub Release and a Marketplace publication are separate actions.

## Official references

- [Publishing extensions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
- [Extension manifest](https://code.visualstudio.com/api/references/extension-manifest)
- [Marketplace presentation](https://code.visualstudio.com/api/references/extension-manifest#marketplace-presentation-tips)
