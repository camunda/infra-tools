# One action with `tools` and `tool-cache` inputs

Jobs use a single action, `camunda/infra-tools@<sha>`, with two inputs: `tools` for plain tools, which are ready to use, and `tool-cache` for tool-cache tools, which are only placed in the tool cache so their official `setup-*` action finds them instead of downloading them. We don't reimplement what `setup-*` actions configure. A tool listed in the wrong input fails with a message naming the right input. One action means one pin, one index lookup and one Renovate update. The separate input keeps the cache-only behaviour visible in the workflow. Without it, a job listing `java@21` on a GitHub-hosted runner, with no `setup-java` step after it, would silently run the Java 17 already on `PATH`.

```yaml
- id: tools
  uses: camunda/infra-tools@<sha> # X.Y.Z
  with:
    tools: |
      maven@3
    tool-cache: |
      java@21
- uses: actions/setup-java@v5
  with:
    distribution: temurin
    java-version: ${{ fromJSON(steps.tools.outputs.versions).java }}
```

## Considered Options

- **Two actions** (root action for plain tools, `camunda/infra-tools/cache` for tool-cache tools; spec D42, which this ADR replaces): two pins, two steps and two index lookups per job, harder to explain.
- **One input with a prefix** (`cache:java@21`): one list, but the prefix complicates selectors and Renovate's matching.
- **One input, kind taken from the tool definition**: simplest YAML, but leaves the wrong-version case above invisible in the workflow.
