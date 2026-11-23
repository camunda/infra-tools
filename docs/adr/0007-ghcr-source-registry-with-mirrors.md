# GHCR as the source registry, with pull-through mirrors per cloud

GitHub Packages (`ghcr.io`) is the source registry, and GitHub-hosted runners read from it: storage is free today, and pulls from GitHub Actions with the job token are free and stay in the same infrastructure. The package stays internal: org policy does not allow public packages. Each self-hosted runner set reads from a mirror in its own cloud: Artifact Registry on GCP, ECR on AWS. The mirror holds the same digests and is configured once per runner set, so workflows don't change. Runners authenticate to their mirror with their own identity (Workload Identity, IRSA, the job token), with no long-lived secret on the runner. If the mirror fails, the action falls back to the source registry with a warning, so losing one registry does not break CI.

Mirrors are filled by pull-through caching: each mirror proxies `ghcr.io`. Because the package is internal, the mirror needs a credential for `ghcr.io`: a classic PAT with only `read:packages`, owned by the `infra-connect` service account, stored in GCP Secret Manager and AWS Secrets Manager where the mirrors read it natively. It is the one long-lived credential in the design, and it lives in the cloud secret stores, not on runners or in workflows.

## Considered Options

- **Public package**: no credential for the mirrors, and fork PRs pull without question, but org policy does not allow it today.
- **Prefill at release time**: no credential, but the release then depends on reaching every mirror, and a mirror that proxies another registry may not accept direct pushes.

## Consequences

The action itself remains a point of failure for plain tools. When the action cannot install anything, tool-cache tools still work, because their `setup-*` action downloads them from upstream as it does today, but plain tools have no such fallback and the job fails. Retries and the registry fallback have to make this case rare.

Whether fork PRs of a public consumer repository can pull the internal package with their read-only job token is not documented; it is tested before the rollout, and fork PRs fall back to the usual `setup-*` download if it fails.

## Amendment: the release fills the Artifact Registry mirror (D61)

An Artifact Registry remote repository cannot be scoped to one package: it rejects a path in its upstream URI. With the `infra-connect` PAT, every GKE runner pod, fork PRs of public repositories included, could pull through it any package that account can read. The Artifact Registry mirror is therefore a standard repository, and the release fills it: right after publishing on GHCR, it copies each release index the mirror lacks, with its manifests and layers, logged in with GitHub OIDC. The mirror holds infra-tools release indexes only, and no credential is stored. This brings back the "prefill at release time" option for Artifact Registry. The copy runs in its own job after publication, one matrix entry per mirror, so the release still never depends on reaching a mirror: a failed copy fails only that job, the next run copies it, and GKE runners fall back to GHCR meanwhile.

## Amendment: every mirror is filled before the release is published (ADR 0013)

Every mirror, ECR included, is a standard repository filled by the release, and the release is published only once every mirror holds its index: a tag `X.Y.Z` means its index is on `ghcr.io` and on every mirror, with the same digests. The copy checks digests, not only tags: a mirror tag pointing to other content, such as the earlier index of a retargeted draft, is replaced by the index on `ghcr.io`, the reference, which nothing reads before the release is published; a published release's index is never copied again. This reverses the order of the first amendment (D61), which copied after publication so that a release never depends on a mirror, and drops pull-through for ECR (D48). A mirror outage now delays the release instead of sending runners to `ghcr.io` for it: a daily release can wait, and there is no published release that some runners cannot read from their mirror. The action still falls back to `ghcr.io` when its mirror fails at install time.
