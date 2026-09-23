FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip openssl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run db:generate

WORKDIR /app/apps/api
EXPOSE 3001

CMD ["sh", "-c", "DATABASE_URL=${DIRECT_DATABASE_URL:-$DATABASE_URL} bun run --filter=@crm/db db:deploy && exec bun run start"]
