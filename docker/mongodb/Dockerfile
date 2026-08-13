FROM mongo:8.0.13

RUN install -d -o mongodb -g mongodb -m 0700 /run/secrets

COPY --chown=mongodb:mongodb --chmod=0400 keyfile /run/secrets/mongodb-keyfile
