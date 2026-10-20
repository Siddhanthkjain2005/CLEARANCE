# Security reporting

Please report security vulnerabilities privately through [GitHub's vulnerability reporting form](https://github.com/Siddhanthkjain2005/CLEARANCE/security/advisories/new), rather than a public issue.

Include the affected component, steps to reproduce, expected impact and a minimal example that does not contain real credentials or private project data. Avoid posting tokens, webhook secrets, personal information or production logs.

## Scope and deployment

The public Cloud Run app uses labelled simulated traffic. Connected deployments configure their own authentication, token scopes, owner permissions and secret storage through the [setup guide](docs/setup.md).

The security model combines deterministic policy decisions, platform permissions and owner review. Evidence records use a hash chain with optional HMAC authentication of the chain head. See [architecture](docs/architecture.md) for storage and key-management details.

## Secrets

Use CI secret variables or a suitable secret manager for deployed credentials. Never commit local environment files, private keys, Terraform state or service-account credential files. The checked-in [.env.example](.env.example) contains preview settings only.
