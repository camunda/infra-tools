# Install tools at job time, not from a pre-baked image

camunda/team-infrastructure#1138 first suggested one image with pre-baked tools, used as the self-hosted runner image and as a container-job image on GitHub-hosted runners. We install tools at job time instead: each job lists its tools in one action step, which downloads only the missing ones, the same way on every runner. The self-hosted runner image stays but gets no new tools.

## Considered Options

- **Container-job image on GitHub-hosted runners**: replaces the VM environment (jobs need adjusting) and pulls every tool on every job, most of them unused. GitHub-hosted runners have no way to avoid the download, so it only moves into the job's pick-up time.
- **Pre-baked self-hosted runner image**: opaque (users can't see which versions it holds, and an upgrade can't be tested in a PR), and it ties every repository to our versions and our upgrade timeline.
- **Custom images on larger GitHub-hosted runners**: too expensive.
