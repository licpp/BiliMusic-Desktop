FROM node:22-alpine
WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY server.mjs policy.mjs validation.mjs ./
COPY public ./public
COPY scripts ./scripts
ENV HOST=0.0.0.0 PORT=3180
USER node
EXPOSE 3180
CMD ["node", "server.mjs"]
