FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY *.mjs ./
USER node
ENV HOST=127.0.0.1 PORT=3181 NODE_ENV=production
CMD ["node","server.mjs"]
