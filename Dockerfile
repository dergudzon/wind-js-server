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
      gosu \
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

# Create required directories (permissions fixed at runtime by entrypoint)
RUN mkdir -p /usr/src/app/json-data /usr/src/app/grib-data

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 7000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://localhost:7000/alive', (r) => { process.exit(r.statusCode === 200 ? 0 : 1) })"

# Entrypoint runs as root, chowns volumes, then drops to node user via gosu
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "app.js"]
