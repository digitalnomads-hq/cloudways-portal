# Debian-based rather than Alpine: @resvg/resvg-js and ssh2 ship prebuilt
# binaries against glibc, and musl variants are a common source of
# "cannot find module" failures at runtime.
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# npm ci needs dev deps here — the Next build requires TypeScript and Tailwind.
RUN npm ci

FROM node:22-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Bind to all interfaces so the platform's proxy can reach the container.
ENV HOSTNAME=0.0.0.0

RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs

# output: 'standalone' emits a minimal server plus only the node_modules it
# actually traced. Static assets and public/ are not included and are copied in.
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

USER nextjs

# Render injects PORT; this is only the default for local `docker run`.
ENV PORT=3000
EXPOSE 3000

CMD ["node", "server.js"]
