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

FROM docker.io/library/ubuntu:22.04@sha256:0e0a0fc6d18feda9db1590da249ac93e8d5abfea8f4c3c0c849ce512b5ef8982 AS guard-builder

RUN export DEBIAN_FRONTEND=noninteractive TZ=Etc/UTC \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
      build-essential \
      libseccomp-dev \
    && rm -rf /var/lib/apt/lists/*

COPY container/submission-guard.c /tmp/submission-guard.c
RUN cc \
      -std=c17 \
      -O2 \
      -fPIE \
      -fstack-protector-strong \
      -D_FORTIFY_SOURCE=2 \
      -Wall \
      -Wextra \
      -Werror \
      -Wformat=2 \
      -Werror=format-security \
      /tmp/submission-guard.c \
      -lseccomp \
      -pie \
      -Wl,-z,relro,-z,now \
      -o /tmp/submission-guard

FROM docker.io/library/eclipse-temurin:21.0.8_9-jdk-jammy@sha256:adb9b2d15adf1833d9dae0bdc1cff61ef5a804dc58dfbfb34269f32432b2e5dc AS java-runtime

# Cloudflare runs every Sandbox in its own resource-limited VM. The final
# image extends the pinned glibc Sandbox runtime directly instead of starting
# an unsupported nested daemon that cannot receive delegated cgroups.
FROM docker.io/cloudflare/sandbox:0.12.7@sha256:6d741713aef266e8ae0831a5709c6f2d7b77b4952ac79b549f4f4e380af86fbe

USER root

COPY --from=python-builder /opt/python/3.13.5 /opt/python/3.13.5
COPY --from=guard-builder /tmp/submission-guard /opt/leetbattle/submission-guard
COPY --from=java-runtime /opt/java/openjdk /opt/java/openjdk
COPY container/run-judge.sh /opt/leetbattle/run-judge

RUN groupadd --gid 65532 leetbattle-runner \
    && useradd \
      --uid 65532 \
      --gid 65532 \
      --no-create-home \
      --home-dir /nonexistent \
      --shell /usr/sbin/nologin \
      leetbattle-runner \
    && chown root:root \
      /opt/leetbattle/run-judge \
      /opt/leetbattle/submission-guard \
    && chmod 0555 \
      /opt/leetbattle/run-judge \
      /opt/leetbattle/submission-guard \
    && install -d -o root -g root -m 0755 /workspace \
    && printf '%s\n' /opt/python/3.13.5/lib \
      > /etc/ld.so.conf.d/leetbattle-python.conf \
    && ldconfig \
    && /opt/python/3.13.5/bin/python3.13 --version \
    && /opt/java/openjdk/bin/java -version \
    && /opt/java/openjdk/bin/javac -version \
    && /usr/bin/prlimit --version \
    && /usr/bin/setpriv --version \
    && ldd /opt/leetbattle/submission-guard \
      | grep -F 'libseccomp.so.2'

ENV SANDBOX_VERSION="0.12.7"
ENV PYTHON_POOL_MIN_SIZE="0"
ENV JAVASCRIPT_POOL_MIN_SIZE="0"
ENV TYPESCRIPT_POOL_MIN_SIZE="0"
WORKDIR /workspace

ENTRYPOINT ["/container-server/sandbox"]
CMD ["/bin/sleep", "infinity"]
