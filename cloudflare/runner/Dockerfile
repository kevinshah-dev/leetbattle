FROM docker.io/library/ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS python-builder

ARG PYTHON_VERSION=3.13.5
ARG PYTHON_SHA256=e6190f52699b534ee203d9f417bdbca05a92f23e35c19c691a50ed2942835385

RUN export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      libbz2-dev \
      libffi-dev \
      libgdbm-dev \
      liblzma-dev \
      libncursesw5-dev \
      libreadline-dev \
      libsqlite3-dev \
      libssl-dev \
      pkg-config \
      tk-dev \
      uuid-dev \
      xz-utils \
      zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /tmp/python-build
RUN curl -fsSLO "https://www.python.org/ftp/python/${PYTHON_VERSION}/Python-${PYTHON_VERSION}.tgz" \
    && echo "${PYTHON_SHA256}  Python-${PYTHON_VERSION}.tgz" | sha256sum -c - \
    && tar -xzf "Python-${PYTHON_VERSION}.tgz" --strip-components=1 \
    && ./configure \
      --prefix="/opt/python/${PYTHON_VERSION}" \
      --enable-shared \
      --with-ensurepip=no \
    && make -j"$(nproc)" \
    && make install

FROM docker.io/library/eclipse-temurin:21.0.8_9-jdk-jammy@sha256:adb9b2d15adf1833d9dae0bdc1cff61ef5a804dc58dfbfb34269f32432b2e5dc AS java-runtime

# This stage is imported into the rootless Docker daemon at Sandbox startup.
# It contains no application secrets or user data, and it is always run with
# a read-only root filesystem and no network namespace.
FROM docker.io/library/ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS judge-rootfs

RUN export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC \
    && apt-get update \
    && apt-get install -y --no-install-recommends coreutils \
    && groupadd --gid 65532 leetbattle-runner \
    && useradd \
      --uid 65532 \
      --gid 65532 \
      --no-create-home \
      --home-dir /nonexistent \
      --shell /usr/sbin/nologin \
      leetbattle-runner \
    && install -d -o root -g root -m 0555 \
      /build /opt/leetbattle /submission \
    && install -d -o 65532 -g 65532 -m 0700 /workspace \
    && touch \
      /submission/Harness.java \
      /submission/Solution.java \
      /submission/harness.py \
      /submission/solution.py \
    && chmod 0444 /submission/* \
    && rm -rf /var/lib/apt/lists/*

COPY --from=python-builder /opt/python/3.13.5 /opt/python/3.13.5
COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk
COPY container/verify-inner-isolation.sh /opt/leetbattle/verify-inner-isolation
COPY container/compile-inner.sh /opt/leetbattle/compile-inner
COPY container/run-inner.sh /opt/leetbattle/run-inner

RUN chown root:root \
      /opt/leetbattle/verify-inner-isolation \
      /opt/leetbattle/compile-inner \
      /opt/leetbattle/run-inner \
    && chmod 0555 \
      /opt/leetbattle/verify-inner-isolation \
      /opt/leetbattle/compile-inner \
      /opt/leetbattle/run-inner \
    && printf '%s\n' /opt/python/3.13.5/lib > /etc/ld.so.conf.d/leetbattle-python.conf \
    && ldconfig \
    && /opt/python/3.13.5/bin/python3.13 --version \
    && /opt/java/openjdk/bin/java -version \
    && /opt/java/openjdk/bin/javac -version

# Docker cannot COPY a stage directly into its image store. Archive the exact
# pinned judge rootfs during the outer image build, verify it again at runtime,
# and import it without any registry or public-network access.
FROM judge-rootfs AS judge-rootfs-archive
RUN tar \
      --numeric-owner \
      --exclude=./dev/* \
      --exclude=./proc/* \
      --exclude=./sys/* \
      --exclude=./tmp/* \
      -C / \
      -cf /tmp/leetbattle-judge-rootfs.tar \
      . \
    && sha256sum /tmp/leetbattle-judge-rootfs.tar \
      > /tmp/leetbattle-judge-rootfs.tar.sha256

FROM docker.io/cloudflare/sandbox:0.12.4-musl@sha256:d0807feeabe3be48527982e3b8753b66f538aaca4ee69b0fe4faf74cb53e2d29 AS sandbox-runtime

# Cloudflare documents docker:dind-rootless for nested containers. The daemon
# and Sandbox control plane both run as the unprivileged rootless user.
FROM docker.io/library/docker:29.6.2-dind-rootless@sha256:212a9e782c7119fd6a212beaab6b7665a29b663d894d0f6201710c89575ad0ae

USER root
RUN apk add --no-cache bash coreutils curl jq

COPY --from=sandbox-runtime /container-server/sandbox /sandbox
COPY --from=sandbox-runtime /usr/lib/libstdc++.so.6 /usr/lib/libstdc++.so.6
COPY --from=sandbox-runtime /usr/lib/libgcc_s.so.1 /usr/lib/libgcc_s.so.1
COPY --from=sandbox-runtime /usr/lib/libreadline.so.8 /usr/lib/libreadline.so.8
COPY --from=sandbox-runtime /usr/lib/libreadline.so.8.2 /usr/lib/libreadline.so.8.2

COPY --from=judge-rootfs-archive \
  /tmp/leetbattle-judge-rootfs.tar \
  /opt/leetbattle/judge-rootfs.tar
COPY --from=judge-rootfs-archive \
  /tmp/leetbattle-judge-rootfs.tar.sha256 \
  /opt/leetbattle/judge-rootfs.tar.sha256
COPY container/boot-rootless-docker.sh /opt/leetbattle/boot-rootless-docker
COPY container/run-judge.sh /opt/leetbattle/run-judge

RUN chown -R root:root /opt/leetbattle \
    && chmod 0444 \
      /opt/leetbattle/judge-rootfs.tar \
      /opt/leetbattle/judge-rootfs.tar.sha256 \
    && chmod 0555 \
      /sandbox \
      /opt/leetbattle/boot-rootless-docker \
      /opt/leetbattle/run-judge \
    && install -d -o rootless -g rootless -m 0700 \
      /home/rootless/.cache/leetbattle \
      /home/rootless/.local/share/docker \
      /workspace

USER rootless
ENV HOME="/home/rootless"
ENV DOCKER_HOST="unix:///run/user/1000/docker.sock"
ENV DOCKER_TLS_CERTDIR=""
ENV SANDBOX_VERSION="0.12.4"
ENV PYTHON_POOL_MIN_SIZE="0"
ENV JAVASCRIPT_POOL_MIN_SIZE="0"
ENV TYPESCRIPT_POOL_MIN_SIZE="0"
WORKDIR /home/rootless

ENTRYPOINT ["/sandbox"]
CMD ["/opt/leetbattle/boot-rootless-docker"]
