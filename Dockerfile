# Build stage — needs dev dependencies for the Nest compiler.
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Strip dev dependencies once the build no longer needs them, so they are
# never copied into the runtime image.
RUN npm prune --omit=dev

# Runtime stage.
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

# Run as an unprivileged user. node:alpine ships a `node` user for this.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Uses the app's own readiness check, so an unhealthy database marks the
# container unhealthy rather than leaving it to serve failing requests.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
