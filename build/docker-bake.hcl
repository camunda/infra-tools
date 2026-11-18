# Build and test of one tool version (scripts/build.mjs sets the variables from the tool definition, spec §5.2).
# `test` runs the tool's test.sh on every platform; `tool` is the FROM scratch tool image pushed to the registry.
variable "TOOL" {}
variable "VERSION" {}
variable "FOLDER_VERSION" {}
variable "CACHE_FOLDER" {}
variable "ARCH_FOLDERS" {}
variable "IMAGE" {
  default = ""
}

variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}

target "_args" {
  args = {
    VERSION        = VERSION
    FOLDER_VERSION = FOLDER_VERSION
    CACHE_FOLDER   = CACHE_FOLDER
    ARCH_FOLDERS   = ARCH_FOLDERS
  }
  platforms = split(",", PLATFORMS)
}

target "builder" {
  context    = "build"
  dockerfile = "builder.Dockerfile"
  platforms  = split(",", PLATFORMS)
}

target "tool" {
  inherits   = ["_args"]
  context    = "tools/${TOOL}"
  dockerfile = "../../build/tool.Dockerfile"
  contexts   = { builder = "target:builder" }
  tags       = IMAGE == "" ? [] : [IMAGE]
  output     = ["type=cacheonly"]
}

target "test" {
  inherits   = ["_args"]
  context    = "tools/${TOOL}"
  dockerfile = "../../build/test.Dockerfile"
  contexts   = { tool = "target:tool" }
  output     = ["type=cacheonly"]
}
