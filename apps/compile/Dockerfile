# LaTeX compile service: Tectonic + a tiny Node HTTP server.
# Build context: the repository root (templates are used to pre-warm the package cache).
FROM node:22-bookworm-slim

ARG TECTONIC_VERSION=0.15.0
ARG TARGETARCH
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl fontconfig \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in \
      arm64) TRIPLE=aarch64-unknown-linux-musl ;; \
      *) TRIPLE=x86_64-unknown-linux-musl ;; \
    esac \
 && curl -fsSL "https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic%40${TECTONIC_VERSION}/tectonic-${TECTONIC_VERSION}-${TRIPLE}.tar.gz" \
    | tar -xz -C /usr/local/bin tectonic \
 && tectonic --version

RUN useradd --create-home --uid 10001 compiler
USER compiler
WORKDIR /home/compiler/app

# Pre-warm Tectonic's package cache by compiling every starter template and a document using
# common packages, so the service works with no network access at runtime.
COPY --chown=compiler apps/server/templates /tmp/templates
COPY --chown=compiler apps/compile/warmup /tmp/warmup
RUN set -e; \
    mkdir -p /tmp/out; \
    for d in /tmp/templates/*/; do \
      if [ -f "$d/main.tex" ]; then (cd "$d" && tectonic -X compile main.tex --outdir /tmp/out --untrusted); fi; \
    done; \
    cd /tmp/warmup && tectonic -X compile extras.tex --outdir /tmp/out --untrusted; \
    rm -rf /tmp/out /tmp/warmup

COPY --chown=compiler apps/compile/src ./src
ENV NODE_ENV=production PORT=7000
EXPOSE 7000
CMD ["node", "src/server.mjs"]
