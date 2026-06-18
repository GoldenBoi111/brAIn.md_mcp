# Multi-stage build for optimized Next.js production image

# Stage 1: Dependencies
FROM node:20-alpine AS dependencies
WORKDIR /app
COPY pnpm-lock.yaml package.json ./
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Stage 2: Builder
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=dependencies /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml tsconfig.json ./
COPY app ./app
RUN npm install -g pnpm && pnpm run build

# Stage 3: Runtime
FROM node:20-alpine
WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directories
RUN mkdir -p /app/vaults /app/.auth

COPY --from=builder /app/package.json /app/pnpm-lock.yaml ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY public ./public

EXPOSE 3000

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start Next.js in production mode
CMD ["npm", "start"]
