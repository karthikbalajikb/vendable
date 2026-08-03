# Production image for the Vendable platform server.
# Serves the operator dashboard at /app plus every /api/* route (onboard, trust,
# certify, ucp/catalog, ucp/buy, ucp/onboard, prava, mcp) and /agent/*.
#
# Secrets are provided by the host as environment variables (PRAVA_*, SENSO_API_KEY,
# OPENAI_API_KEY, SUPABASE_*, etc.) — do NOT bake .env into the image.
FROM node:22-slim
WORKDIR /app

# Install deps (incl. tsc/tsx for the build) against the lockfile when present.
COPY package.json ./
COPY package-lock.json* ./
RUN npm install

# App source + the static dashboard it serves.
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# Compile TypeScript -> dist/ (NodeNext, .js import specifiers resolve in dist).
RUN npm run build

ENV NODE_ENV=production
# Hosts (Render/Railway/Fly) inject PORT; index.ts reads process.env.PORT ?? 4000.
EXPOSE 4000
CMD ["node", "dist/index.js", "serve"]
