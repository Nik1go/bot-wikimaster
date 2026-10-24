FROM mcr.microsoft.com/playwright:v1.64.0-noble

USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends xvfb x11-utils x11vnc novnc websockify openbox \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY docker/entrypoint.sh /app/entrypoint.sh
RUN sed -i 's/\r$//' /app/entrypoint.sh \
    && chmod 755 /app/entrypoint.sh \
    && mkdir -p /data/state /data/chromium \
    && chown -R pwuser:pwuser /data /app
USER pwuser
ENV DISPLAY=:99 DATA_DIR=/data TZ=Europe/Paris
EXPOSE 6080
ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["run"]
