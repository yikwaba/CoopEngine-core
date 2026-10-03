FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY . .
RUN pnpm install --frozen-lockfile
ARG STAGING_SOURCE_SHA=unknown
ENV NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_URL=http://localhost:4399/api/v1
RUN pnpm build
RUN printf '%s\n' "$STAGING_SOURCE_SHA" > /app/staging-source-sha
RUN mkdir -p /app/staging-documents && chown node:node /app/staging-documents
USER node
CMD ["node", "apps/api/dist/main.js"]
