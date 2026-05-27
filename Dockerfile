# ---- Stage 1: Install Node.js dependencies ----
FROM node:20-slim AS deps

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# ---- Stage 2: Final runtime image ----
FROM node:20-slim

# Install Java JRE (required by grib2json converter) and dumb-init
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      default-jre-headless \
      dumb-init \
    && rm -rf /var/lib/apt/lists/*

# Set JAVA_HOME so grib2json shell script can find java
ENV JAVA_HOME=/usr/lib/jvm/default-java
ENV NODE_ENV=production
ENV PORT=7000

WORKDIR /usr/src/app

# Copy only production node_modules from deps stage
COPY --from=deps /usr/src/app/node_modules ./node_modules

# Copy application source
COPY . .

# Create non-root user (added to node group for volume write access) and required directories
RUN groupadd -r appuser && \
    useradd -r -g appuser -G node appuser && \
    mkdir -p /usr/src/app/json-data /usr/src/app/grib-data && \
    chown -R appuser:appuser /usr/src/app

USER appuser

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/alive', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "app.js"]
