# Changelog

## [1.2.0](https://github.com/camunda/infra-tools/compare/1.1.0...1.2.0) (2026-11-21)


### Features

* add the selected tools to the job summary with summary: true ([89fe3e7](https://github.com/camunda/infra-tools/commit/89fe3e7adf588a4cfc97a5af4af55813ceb892c6))
* check a repository's selectors against the index with mode: validate ([d980a26](https://github.com/camunda/infra-tools/commit/d980a2609b4e0d8ba0dbb27874f686a0e1a4613d))
* install from the index of the pinned release without the index input ([3d29809](https://github.com/camunda/infra-tools/commit/3d29809802582dac4bf8e895ec5eb7a8edc9609d))
* install from the runner set's mirror, filled by the release ([74f1bc3](https://github.com/camunda/infra-tools/commit/74f1bc3ad8321957f8a21205102b921e137569cf))
* **java:** publish 21.0.13+100000002.0.LTS for amd64 ([e6b1546](https://github.com/camunda/infra-tools/commit/e6b154659fb17a442524f8c45f6a1ff30ed9938d))
* **java:** publish 21.0.13+9.0.LTS ([6ffd51f](https://github.com/camunda/infra-tools/commit/6ffd51f1b084f1a8cd177ec409bc4fd7065bb415))
* **maven:** publish 3.9.16 ([6ffd51f](https://github.com/camunda/infra-tools/commit/6ffd51f1b084f1a8cd177ec409bc4fd7065bb415))
* **node:** publish 26.13.1 ([6ffd51f](https://github.com/camunda/infra-tools/commit/6ffd51f1b084f1a8cd177ec409bc4fd7065bb415))
* pre-fill the tool cache through the tool-cache input ([9779478](https://github.com/camunda/infra-tools/commit/9779478f87ad353e697759259251b2a9a0fbc88f))
* publish each platform when available, adding late platforms as a new revision ([ea06d41](https://github.com/camunda/infra-tools/commit/ea06d4113374f3aae0752c66a179a929321b4453)), closes [#48](https://github.com/camunda/infra-tools/issues/48)
* publish maven by hand and install it with the action ([3d52071](https://github.com/camunda/infra-tools/commit/3d52071a7647c7974c25dc623c90e68b9b05add4)), closes [#20](https://github.com/camunda/infra-tools/issues/20)
* push the tested tool image ([ab1dc15](https://github.com/camunda/infra-tools/commit/ab1dc15b69b1ee625060ab14d2dc1ba431a786ef))


### Bug Fixes

* cut releases only from record commits and action changes ([a8bf802](https://github.com/camunda/infra-tools/commit/a8bf802d9a7a411c606e2d51168f8c23a6bcbfe3))
* merge the release PR from a tested script that reports whether it merged or only enabled auto-merge ([614a0eb](https://github.com/camunda/infra-tools/commit/614a0eb7e32d3604c2d1361cb2a99a110a4ae01e))

## [1.1.0](https://github.com/camunda/infra-tools/compare/1.0.0...1.1.0) (2026-11-20)


### Features

* install from the runner set's mirror, filled by the release ([74f1bc3](https://github.com/camunda/infra-tools/commit/74f1bc3ad8321957f8a21205102b921e137569cf))

## 1.0.0 (2026-11-19)


### Features

* add the selected tools to the job summary with summary: true ([89fe3e7](https://github.com/camunda/infra-tools/commit/89fe3e7adf588a4cfc97a5af4af55813ceb892c6))
* check a repository's selectors against the index with mode: validate ([d980a26](https://github.com/camunda/infra-tools/commit/d980a2609b4e0d8ba0dbb27874f686a0e1a4613d))
* install from the index of the pinned release without the index input ([3d29809](https://github.com/camunda/infra-tools/commit/3d29809802582dac4bf8e895ec5eb7a8edc9609d))
* **java:** publish 21.0.13+9.0.LTS ([6ffd51f](https://github.com/camunda/infra-tools/commit/6ffd51f1b084f1a8cd177ec409bc4fd7065bb415))
* **maven:** publish 3.9.16 ([6ffd51f](https://github.com/camunda/infra-tools/commit/6ffd51f1b084f1a8cd177ec409bc4fd7065bb415))
* **node:** publish 26.13.1 ([6ffd51f](https://github.com/camunda/infra-tools/commit/6ffd51f1b084f1a8cd177ec409bc4fd7065bb415))
* pre-fill the tool cache through the tool-cache input ([9779478](https://github.com/camunda/infra-tools/commit/9779478f87ad353e697759259251b2a9a0fbc88f))
* publish maven by hand and install it with the action ([3d52071](https://github.com/camunda/infra-tools/commit/3d52071a7647c7974c25dc623c90e68b9b05add4)), closes [#20](https://github.com/camunda/infra-tools/issues/20)
* push the tested tool image ([ab1dc15](https://github.com/camunda/infra-tools/commit/ab1dc15b69b1ee625060ab14d2dc1ba431a786ef))


### Bug Fixes

* cut releases only from record commits and action changes ([a8bf802](https://github.com/camunda/infra-tools/commit/a8bf802d9a7a411c606e2d51168f8c23a6bcbfe3))
* merge the release PR from a tested script that reports whether it merged or only enabled auto-merge ([614a0eb](https://github.com/camunda/infra-tools/commit/614a0eb7e32d3604c2d1361cb2a99a110a4ae01e))
