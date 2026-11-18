# Build and test of one tool version (scripts/build.mjs sets the variables from the tool definition, spec §5.2).
# `tool` writes the FROM scratch tool image to the OCI layout LAYOUT; `test` runs the tool's test.sh on every platform against
# that layout, which scripts/build.mjs then pushes as it is.
variable "TOOL" {}
variable "VERSION" {}
variable "FOLDER_VERSION" {}
variable "CACHE_FOLDER" {}
variable "ARCH_FOLDERS" {}
variable "LAYOUT" {}

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
  output     = ["type=oci,dest=${LAYOUT},tar=false"]
}

target "test" {
  inherits   = ["_args"]
  context    = "tools/${TOOL}"
  dockerfile = "../../build/test.Dockerfile"
  contexts   = { tool = "oci-layout://${LAYOUT}" }
  output     = ["type=cacheonly"]
}
