# Layers keep the full `opt/hostedtoolcache/...` path

Each layer holds `opt/hostedtoolcache/<folder>/<version>/<arch>` rather than the tool folder at its root, and the action strips the leading path components when it extracts the layer. This keeps a tool image usable as-is in places other than the action: a Kubernetes image volume or a runner image built from tool images. Published layers never change, so changing the layout later would mean republishing every tool version.
