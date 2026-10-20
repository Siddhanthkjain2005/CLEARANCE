# Contributing to Clearance

Keep changes focused, explain the intended behaviour and include the verification needed to review them.

## Development

Use Node.js 22.18 or newer.

```sh
npm ci
npm run dev
```

The local preview is available at `http://localhost:8080`. Without a GitLab project and credentials, traffic is simulated and labelled.

## Before opening a pull request

1. Read [AGENTS.md](AGENTS.md) and identify the repository sectors affected.
2. Predict clearance with `node src/cli/clearance.ts predict --files path/to/file.ts:linesAdded:linesRemoved`.
3. Keep runtime code in its existing layer: pure decisions in `src/core/`, effects in the CLI/Tower and presentation in `src/web/`.
4. Add meaningful tests for behavioural changes. Keep documentation and examples aligned with the actual implementation.
5. Run the relevant checks, followed by the complete sequence when changing shared behaviour:

```sh
npm run typecheck
npm test
npm run build
node src/cli/clearance.ts budget dist/web
node src/cli/clearance.ts doccheck
npm run test:smoke
```

The GitHub workflow checks this sequence. The GitLab templates remain the product's delivery-automation configuration.

## Code conventions

- Use erasable TypeScript and retain `.ts` import extensions.
- Use two spaces, single quotes, semicolons and trailing commas in multiline literals.
- Avoid new Tower runtime dependencies. Development dependency changes require owner review.
- Preserve accessible labels, focus behaviour, reduced-motion handling and mobile layouts when changing the console.
- Keep simulated data labelled. Do not describe fixtures as real Duo runs, production measurements or earned live trust.

## Governance changes

Agents must not edit protected governance, Duo definitions, security policies or CODEOWNERS. Propose those changes for explicit human owner review as described in [AGENTS.md](AGENTS.md). Do not rewrite trust history or weaken policy to make a demonstration pass.

## Commits and pull requests

Use conventional commit subjects such as `fix:`, `feat:`, `docs:` or `test:`. Follow the repository's pilot-identification trailer requirement. Include the problem and resulting behaviour, affected components, checks run, screenshots for visible changes and any owner configuration still required.

Never include credentials, `.env` files, Terraform state or generated dependency/build folders. Use the private process in [SECURITY.md](SECURITY.md) for vulnerabilities.
