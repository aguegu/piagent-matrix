REPO    := aguegu/piagent-matrix
# The moving tag while a release is open. `release` overrides it with VER.
VERSION := edge
# amd64 only, and deliberately: the crypto binding ships linux-x64-gnu with no
# musl or arm64 variant, and supercronic is pinned to amd64. A build for
# anything else succeeds and then fails at exec.
PLATFORM := linux/amd64
VER != node -p "require('./package.json').version"

test:
	npm test

push:
	docker build --platform ${PLATFORM} --build-arg VERSION=${VER} -t ${REPO}:${VERSION} .
	docker push ${REPO}:${VERSION}

# Tag the image with the package version and move `latest` onto it. Tests
# first: the image carries no test suite, so this is the last place to run it.
release: test
	$(MAKE) VERSION=${VER} push
	docker tag ${REPO}:${VER} ${REPO}:latest
	docker push ${REPO}:latest

.PHONY: test push release
