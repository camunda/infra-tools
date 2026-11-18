# Build and test of one tool version (scripts/build.mjs sets the variables from the tool definition, spec §5.2).
# `tool` writes the FROM scratch tool image to the OCI layout LAYOUT; `test` runs the tool's test.sh on every platform and every
# Ubuntu release of UBUNTU_RELEASES against that layout, which scripts/build.mjs then pushes as it is.
variable "TOOL" {}
variable "VERSION" {}
variable "FOLDER_VERSION" {}
variable "CACHE_FOLDER" {}
variable "ARCH_FOLDERS" {}
variable "LAYOUT" {}

variable "PLATFORMS" {
  default = "linux/amd64,linux/arm64"
}

# Every Ubuntu release our runners use (D58): add one when runners offer it, drop one when no runner set uses it.
variable "UBUNTU_RELEASES" {
  default = "24.04,26.04"
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
  name       = "test-ubuntu-${replace(ubuntu, ".", "-")}"
  matrix     = { ubuntu = split(",", UBUNTU_RELEASES) }
  inherits   = ["_args"]
  args       = { UBUNTU = ubuntu }
  context    = "tools/${TOOL}"
  dockerfile = "../../build/test.Dockerfile"
  contexts   = { tool = "oci-layout://${LAYOUT}", build = "build" }
  output     = ["type=cacheonly"]
}
