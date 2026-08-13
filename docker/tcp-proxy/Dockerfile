FROM node:24.14.0-bookworm-slim

WORKDIR /app
COPY --chown=node:node proxy.js ./proxy.js

USER node
CMD ["node", "proxy.js"]
