# Build context: repository root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/crdt/package.json packages/crdt/
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --include-workspace-root -w @weave/server -w @weave/crdt -w @weave/protocol
COPY packages ./packages
COPY apps/server ./apps/server
RUN npx tsc -b apps/server && npm prune --omit=dev --include-workspace-root -w @weave/server -w @weave/crdt -w @weave/protocol

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
COPY --from=build /app/packages/crdt/package.json ./packages/crdt/
COPY --from=build /app/packages/crdt/dist ./packages/crdt/dist
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/apps/server/package.json ./apps/server/
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY apps/server/migrations ./apps/server/migrations
COPY apps/server/templates ./apps/server/templates
USER node
WORKDIR /app/apps/server
EXPOSE 8001
CMD ["node", "dist/main.js"]
