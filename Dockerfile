# Wowok Proof Gatekeeper — zkVerify Agent Games
FROM node:22-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY agent/package.json ./agent/
RUN cd agent && npm install --omit=dev --no-audit --no-fund
COPY agent/ ./agent/
COPY circuits/ ./circuits/
COPY scripts/fetch-circuits.sh ./scripts/
RUN chmod +x ./scripts/fetch-circuits.sh && ./scripts/fetch-circuits.sh
ENV PORT=8080 HOST=0.0.0.0 NODE_ENV=production
EXPOSE 8080
CMD ["node", "agent/server.mjs"]
