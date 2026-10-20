# syntax=docker/dockerfile:1.7
# Clearance Tower: one zero-dependency Node process on a distroless base.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build:web

FROM gcr.io/distroless/nodejs22-debian12:nonroot
WORKDIR /app
ARG CLEARANCE_COMMIT=dev
ENV NODE_ENV=production \
    PORT=8080 \
    CLEARANCE_COMMIT=$CLEARANCE_COMMIT
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src/core ./src/core
COPY --from=build /app/src/tower ./src/tower
COPY --from=build /app/dist/web ./dist/web
COPY .clearance ./.clearance
EXPOSE 8080
USER nonroot
CMD ["src/tower/server.ts"]
