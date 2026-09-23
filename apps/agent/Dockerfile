FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends curl unzip openssl && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run db:generate

WORKDIR /app/apps/agent
RUN bunx eve build
EXPOSE 2000

CMD ["bun", "run", "start"]
