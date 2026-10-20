# Security reporting

Please report security vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/Siddhanthkjain2005/CLEARANCE/security/advisories/new), rather than a public issue.

Include the affected component, steps to reproduce, expected impact and a minimal example that does not contain real credentials or private project data. Avoid posting tokens, webhook secrets, personal information or production logs.

## Scope and deployment

The public Cloud Run app currently uses labelled simulated traffic. GitLab credentials and production delivery integration are not configured in that preview. Private deployments must configure their own authentication, token scopes, owner permissions and secret storage.

The governor is an explicit policy mechanism, not a substitute for GitLab permissions or owner review. Evidence hashes and optional HMAC authentication have the integrity and key-management limits described in the [website walkthrough](docs/demo/website-walkthrough.md).

## Secrets

Use CI secret variables or a suitable secret manager for deployed credentials. Never commit local environment files, private keys, Terraform state or service-account credential files. The checked-in [.env.example](.env.example) contains preview settings only.
