# A reconciler publishes every upstream version

A scheduled reconciler lists each tool's upstream versions through Renovate's datasources, used as a library, and publishes every version within the tool's version lines that is not published yet. A version that fails to build or test opens a fix PR and is never skipped silently, and every run checks that nothing in range is left unpublished. Tool versions inside this repository are therefore not updated by Renovate PRs. This follows the same model as `actions/node-versions`.

## Considered Options

- **One Renovate PR per version line**: leaves gaps when several versions are released in a burst, and Renovate cannot add a line for a new major on its own.
- **Reconciler without PRs** (containerbase): failures don't get a place where the fix is reviewed.
- **Moving lines** (docker-library): rebuilds tags in place, which breaks immutable tool images.
