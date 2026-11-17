---
status: accepted (how mirrors are filled: proposed)
---

# GHCR as the source registry, with a mirror per cloud

GitHub Packages (`ghcr.io`) is the source registry, and GitHub-hosted runners read from it: storage is free today, and pulls from GitHub Actions with the job token are free and stay in the same infrastructure. Each self-hosted runner set reads from a mirror in its own cloud: Artifact Registry on GCP, ECR on AWS. The mirror holds the same digests and is configured once per runner set, so workflows don't change. Runners authenticate with their own identity (Workload Identity, IRSA, the job token), with no long-lived secret. If the mirror fails, the action falls back to the source registry with a warning, so losing one registry does not break CI.

## Consequences

The action itself remains a point of failure for plain tools. When the action cannot install anything, tool-cache tools still work, because their `setup-*` action downloads them from upstream as it does today, but plain tools have no such fallback and the job fails. Retries and the registry fallback have to make this case rare.

## Open

How mirrors are filled is not decided. Pull-through caching, the proposal's default after review, needs a stored credential for `ghcr.io` while the package is internal, which conflicts with "no long-lived secret". Prefilling at release time needs no credential, but makes the release depend on reaching every mirror. The answer depends on the package's visibility (spec Q14).
