# Base image for the docker sandbox driver. Build with `npm run sandbox:image`,
# which tags it jj-sandbox:base-1; bump the tag when the contents change.
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

# The driver runs every command as uid:gid 1000:1000. The node image already
# has that user as "node"; rename it, and give it the workspace mount point so
# a fresh named volume mounted there starts owned by it.
RUN usermod --login sandbox --home /home/sandbox --move-home node \
  && groupmod --new-name sandbox node \
  && mkdir /workspace \
  && chown sandbox:sandbox /workspace

LABEL org.opencontainers.image.title="jj-sandbox" \
  org.opencontainers.image.description="JJ Bot sandbox base image" \
  jj.sandbox.image="base-1"

USER 1000:1000
WORKDIR /workspace
