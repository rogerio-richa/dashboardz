FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY admin/package.json admin/package-lock.json admin/
RUN npm --prefix admin ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/static ./static
# The theme-pack checker (plain ESM, loaded at runtime by the pack install routes).
COPY --from=build /app/packs ./packs
EXPOSE 8484
VOLUME /data
CMD ["node", "dist/index.js"]
