# Contributing

ProofPatch checks software and records the results. Contributions should keep that workflow clear and easy to use.

## Set up

Install Node.js 22 or newer and Git, then run:

```sh
git clone https://github.com/Enerep/PROOFPATCH.git
cd PROOFPATCH
npm ci
npm run check
npm test
```

Run the local CLI with:

```sh
node bin/proofpatch.js --help
node bin/proofpatch.js verify
```

Install Chromium once to run browser scenarios:

```sh
npx playwright install chromium
npm run demo
```

The demo starts a local app, exercises its browser scenario, and saves a report. To include real browser integration tests in `npm test`, set the `PROOFPATCH_BROWSER_TESTS` environment variable to `1`. For example, on macOS or Linux:

```sh
PROOFPATCH_BROWSER_TESTS=1 npm test
```

CI runs these browser tests and the demo on Ubuntu, alongside the regular Node.js checks on Ubuntu and Windows.

See `examples/proofpatch.config.json` for a configuration with command checks and a browser scenario. Adapt its scripts, URL, and expected text to your application before using it.

## Submit a change

1. Create a branch and make a focused change.
2. Add a test when changing verification behavior.
3. Run `npm run check` and `npm test`. For browser changes, also run the browser integration tests and `npm run demo`.
4. Open a pull request describing the problem, the change, and how you tested it.

Include reproduction steps for bug reports. For browser problems, include the operating system, Node.js version, relevant configuration, and observed result.

Reports may contain command output, application data, and screenshots. Review and remove private information before attaching evidence to a public issue or pull request.
