# Static targets; build.mjs adds one line-<id> and test-<id> target per planned tool version.
variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}

target "builder" {
  context    = "build"
  dockerfile = "builder.Dockerfile"
  platforms  = split(",", PLATFORMS)
}

target "_line" {
  contexts   = { builder = "target:builder" }
  platforms  = split(",", PLATFORMS)
  output     = ["type=cacheonly"]
}

target "_test" {
  platforms  = split(",", PLATFORMS)
  output     = ["type=cacheonly"]
}
