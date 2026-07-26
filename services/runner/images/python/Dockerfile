FROM python:3.13.5-slim-bookworm

RUN groupadd --gid 65532 sandbox \
    && useradd --uid 65532 --gid 65532 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin sandbox \
    && mkdir -p /runner \
    && chown root:root /runner \
    && chmod 0555 /runner

COPY run /runner/run
RUN chown root:root /runner/run && chmod 0555 /runner/run

USER 65532:65532
WORKDIR /workspace
ENTRYPOINT ["/runner/run"]
