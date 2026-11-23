# Build context: repository root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/crdt/package.json packages/crdt/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --include-workspace-root -w @weave/web -w @weave/crdt -w @weave/protocol
COPY packages ./packages
COPY apps/web ./apps/web
RUN npx tsc -b packages/crdt packages/protocol && npm run build -w @weave/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
