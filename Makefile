.DEFAULT_GOAL := help

.PHONY: help
help:  ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

# Reinstalled only when the lock file changes.
scripts/node_modules/.package-lock.json: scripts/package-lock.json
	npm ci --prefix scripts

.PHONY: install
install: scripts/node_modules/.package-lock.json  ## Install the dependencies of scripts/

.PHONY: test
test: install  ## Run the tests of scripts/
	npm test --prefix scripts

.PHONY: lint
lint:  ## Run the linters (pre-commit hooks) on all files
	pre-commit run --all-files
