# syntax=docker/dockerfile:1.7
FROM node:24.14.0-bookworm-slim AS dependencies
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM dependencies AS build
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24.14.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 oscar \
  && useradd --system --uid 10001 --gid oscar --home-dir /nonexistent oscar
COPY --from=build --chown=oscar:oscar /app/package.json /app/package-lock.json ./
COPY --from=build --chown=oscar:oscar /app/node_modules ./node_modules
COPY --from=build --chown=oscar:oscar /app/dist ./dist
USER oscar
CMD ["node", "dist/processes/api.js"]
