FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Unprivileged runtime user. It owns only the avatar directory (mounted as a volume).
RUN groupadd --system --gid 10001 fixes \
 && useradd --system --uid 10001 --gid fixes --home-dir /app --shell /usr/sbin/nologin fixes \
 && mkdir -p /data/media \
 && chown fixes:fixes /data/media

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install --no-cache-dir .

USER fixes
ENV FIXES_STORAGE_LOCAL_DIR=/data/media
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["python", "-c", "import sys, urllib.request; sys.exit(urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=4).status != 200)"]

# One process only: rate limits and realtime fan-out live in memory.
# --proxy-headers trusts X-Forwarded-For only from FORWARDED_ALLOW_IPS (see README).
CMD ["uvicorn", "--factory", "fixes_server.main:app_from_env", \
     "--host", "0.0.0.0", "--port", "8000", \
     "--proxy-headers", "--ws-max-size", "65536", "--no-server-header"]
